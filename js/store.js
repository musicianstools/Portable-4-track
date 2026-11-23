'use strict';
/* ===== IndexedDB persistence =====
 * "Saved" is only ever reported after a transaction's `complete` event. */

const Store = (() => {
  const DB_NAME = 'pocket-four-track', DB_VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('This browser has no IndexedDB, so projects cannot be stored.'));
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio', { keyPath: 'id' }).createIndex('projectId', 'projectId');
        if (!db.objectStoreNames.contains('journal')) db.createObjectStore('journal', { keyPath: ['recId', 'seq'] });
        if (!db.objectStoreNames.contains('journalMeta')) db.createObjectStore('journalMeta', { keyPath: 'recId' });
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
      req.onerror = () => reject(req.error || new Error('Could not open local database'));
      req.onblocked = () => reject(new Error('The database is blocked by another open tab of this app. Close other tabs and reload.'));
    });
    return dbp;
  }

  /** Run fn(storeMap) inside a transaction; resolves when the transaction COMPLETES. */
  async function tx(names, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      let t;
      try { t = db.transaction(names, mode); } catch (e) { return reject(e); }
      const stores = {}; (Array.isArray(names) ? names : [names]).forEach(n => stores[n] = t.objectStore(n));
      let result;
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(friendly(t.error));
      t.onabort = () => reject(friendly(t.error || new Error('Transaction aborted')));
      try {
        const r = fn(stores, v => { result = v; });
        if (r !== undefined) result = r;
      } catch (e) { try { t.abort(); } catch (_) { } reject(e); }
    });
  }
  function friendly(err) {
    if (err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''))) {
      const e = new Error('Device storage is full. Export backups and delete old projects to free space.');
      e.name = 'QuotaExceededError'; return e;
    }
    return err || new Error('Storage error');
  }
  const req2p = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function get(store, key) { const db = await open(); return req2p(db.transaction(store).objectStore(store).get(key)); }
  async function getAll(store) { const db = await open(); return req2p(db.transaction(store).objectStore(store).getAll()); }
  async function put(store, value, key) { return tx(store, 'readwrite', s => { key === undefined ? s[store].put(value) : s[store].put(value, key); }); }
  async function del(store, key) { return tx(store, 'readwrite', s => { s[store].delete(key); }); }

  return {
    open, tx, get, getAll, put, del,
    saveProject: p => put('projects', p),
    getProject: id => get('projects', id),
    listProjects: () => getAll('projects'),
    async deleteProject(id) {
      const db = await open();
      const keys = await req2p(db.transaction('audio').objectStore('audio').index('projectId').getAllKeys(id));
      return tx(['projects', 'audio'], 'readwrite', s => { s.projects.delete(id); keys.forEach(k => s.audio.delete(k)); });
    },
    /** audio: {id, projectId, sr, length, data:ArrayBuffer, peaks:ArrayBuffer} */
    putAudio: rec => put('audio', rec),
    getAudio: id => get('audio', id),
    async audioKeysFor(projectId) { const db = await open(); return req2p(db.transaction('audio').objectStore('audio').index('projectId').getAllKeys(projectId)); },
    async deleteAudio(ids) { if (!ids.length) return; return tx('audio', 'readwrite', s => ids.forEach(id => s.audio.delete(id))); },
    /* journal: crash-safe capture */
    putJournal: (meta, chunks) => tx(['journal', 'journalMeta'], 'readwrite', s => { s.journalMeta.put(meta); chunks.forEach(c => s.journal.put(c)); }),
    async listJournals() { return getAll('journalMeta'); },
    async readJournal(recId) {
      const db = await open();
      return req2p(db.transaction('journal').objectStore('journal').getAll(IDBKeyRange.bound([recId, 0], [recId, Infinity])));
    },
    clearJournal: recId => tx(['journal', 'journalMeta'], 'readwrite', s => { s.journalMeta.delete(recId); s.journal.delete(IDBKeyRange.bound([recId, 0], [recId, Infinity])); }),
    kvGet: k => get('kv', k),
    kvSet: (k, v) => put('kv', v, k),
    async estimate() {
      if (!navigator.storage || !navigator.storage.estimate) return null;
      try { return await navigator.storage.estimate(); } catch (_) { return null; }
    },
    async persist() {
      if (!navigator.storage || !navigator.storage.persist) return null;
      try { if (await navigator.storage.persisted()) return true; return await navigator.storage.persist(); } catch (_) { return null; }
    },
    async persisted() { try { return navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : null; } catch (_) { return null; } },
  };
})();
