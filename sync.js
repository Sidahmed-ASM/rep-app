// مزامنة اختيارية مع خادم الشركة. التطبيق يعمل بالكامل بدون هذا الملف (أوفلاين).
// العقد المطلوب من الخادم:
//   POST {serverUrl}/sync    body: {rep:{code,name}, data:{invoices:[...], payments:[...], ...}}  → 200 OK
//   GET  {serverUrl}/master  → {products:[...], customers:[...]}
import * as DB from './db.js';
import { S, load } from './core.js';

const SYNC_STORES = ['invoices', 'returns', 'payments', 'expenses', 'visits', 'loads', 'moves', 'settlements', 'audit', 'customers', 'products'];

export const pendingCount = () => SYNC_STORES.reduce((n, s) => n + S[s].filter((r) => r._synced === false).length, 0);

export async function syncNow() {
  const url = (S.settings.serverUrl || '').trim().replace(/\/$/, '');
  if (!url) throw new Error('لم يتم ضبط عنوان الخادم في الإعدادات');
  const headers = { 'Content-Type': 'application/json' };
  if (S.settings.serverToken) headers.Authorization = 'Bearer ' + S.settings.serverToken;

  const data = {};
  for (const s of SYNC_STORES) {
    const rows = S[s].filter((r) => r._synced === false);
    if (rows.length) data[s] = rows;
  }
  if (Object.keys(data).length) {
    const r = await fetch(url + '/sync', { method: 'POST', headers, body: JSON.stringify({ rep: { code: S.settings.repCode, name: S.settings.repName }, data }) });
    if (!r.ok) throw new Error('فشل الإرسال: ' + r.status);
    for (const [s, rows] of Object.entries(data)) await DB.batch(rows.map((x) => [s, { ...x, _synced: true }]), { sync: false });
  }
  const m = await fetch(url + '/master', { headers });
  if (m.ok) {
    const master = await m.json();
    for (const s of ['products', 'customers']) {
      const localDirty = new Set(S[s].filter((r) => r._synced === false).map((r) => r.id)); // لا نكتب فوق تعديل محلي لم يُرسل
      const rows = (master[s] || []).filter((r) => !localDirty.has(r.id));
      if (rows.length) await DB.batch(rows.map((x) => [s, { ...x, _synced: true }]), { sync: false });
    }
  }
  await load();
}
