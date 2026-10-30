// طبقة التخزين المحلي (IndexedDB) — تعمل بدون إنترنت
const DB_NAME = 'rep_app_db';
const VERSION = 1;
export const STORES = [
  'products', 'customers', 'invoices', 'returns', 'payments', 'expenses',
  'visits', 'loads', 'moves', 'settlements', 'audit', 'meta',
];
let db;

export function open() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, VERSION);
    r.onupgradeneeded = () => {
      for (const s of STORES) if (!r.result.objectStoreNames.contains(s)) r.result.createObjectStore(s, { keyPath: 'id' });
    };
    r.onsuccess = () => {
      db = r.result;
      resolve(db);
    };
    r.onerror = () => reject(r.error);
  });
}

const wrap = (req) => new Promise((res, rej) => ((req.onsuccess = () => res(req.result)), (req.onerror = () => rej(req.error))));

export const all = (store) => wrap(db.transaction(store).objectStore(store).getAll());
export const get = (store, id) => wrap(db.transaction(store).objectStore(store).get(id));

// ops: [[store, obj, 'put'|'del'], ...] — تُنفّذ كلها في معاملة واحدة (إما الكل أو لا شيء)
export function batch(ops, { sync = true } = {}) {
  return new Promise((resolve, reject) => {
    const stores = [...new Set(ops.map((o) => o[0]))];
    const t = db.transaction(stores, 'readwrite');
    for (const [s, obj, kind] of ops) {
      if (kind === 'del') t.objectStore(s).delete(obj.id ?? obj);
      else {
        if (sync && s !== 'meta') obj._synced = false;
        obj._ts = Date.now();
        t.objectStore(s).put(obj);
      }
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const put = (store, obj, sync = true) => batch([[store, obj]], { sync });

export async function clearAll() {
  const t = db.transaction(STORES, 'readwrite');
  STORES.forEach((s) => t.objectStore(s).clear());
  return new Promise((res) => (t.oncomplete = res));
}

export async function dump() {
  const out = {};
  for (const s of STORES) out[s] = await all(s);
  return out;
}

export async function restore(data) {
  await clearAll();
  for (const s of STORES) {
    const rows = data[s] || [];
    if (rows.length) await batch(rows.map((r) => [s, r]), { sync: false });
  }
}
