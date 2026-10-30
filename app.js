import * as DB from './db.js';
import * as C from './core.js';
import { S } from './core.js';
import { $, $$, esc, num, fmt, today, DAYS, weekday, addDays, toast, modal, ask, getLocation, photoToDataURL, shareText, saveFile, printHTML } from './util.js';
import { syncNow, pendingCount } from './sync.js';

const view = $('#view');
const cur = () => esc(S.settings.currency);
const money = (n) => `${fmt(n)} <small>${cur()}</small>`;
const BANKS = () => S.settings.banks || [];
let draft = null; // مستند قيد الإنشاء (فاتورة/مرتجع/شحن...)
let bind = null; // الكائن الذي تُربط به الحقول (data-k)
let form = {}; // حالة النماذج الأخرى
let pinUntil = 0;

const DOC = {
  sell: { title: 'فاتورة بيع', cust: true, price: true },
  return: { title: 'مرتجع من عميل', cust: true, price: true },
  load: { title: 'شحن العربة', cust: false, price: false },
  unload: { title: 'إرجاع للمخزن الرئيسي', cust: false, price: false },
  damage: { title: 'تسجيل تالف', cust: false, price: false },
  sample: { title: 'عينات مجانية', cust: false, price: false },
};

async function needPin(msg = 'أدخل الرقم السري للمشرف') {
  if (Date.now() < pinUntil) return true;
  const v = await ask(msg, { input: true, type: 'password', placeholder: '••••' });
  if (v === S.settings.pin) { pinUntil = Date.now() + 5 * 60e3; return true; }
  if (v !== null) toast('الرقم السري غير صحيح', true);
  return false;
}
const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { toast(e.message || 'حدث خطأ', true); console.error(e); } };
const go = (h) => { location.hash = h; };

// ================= الراوتر =================
const routes = {
  home, more, customers, customer, products, stock, doc, invoice, receipt, collect,
  transfers, expenses, settle, reports, settings, route: routeView, returns: returnsList,
};
const TITLES = { home: 'مندوب المبيعات', more: 'المزيد', customers: 'العملاء', customer: 'العميل', products: 'الأصناف', stock: 'مخزون العربة', invoice: 'الفاتورة', receipt: 'سند القبض', collect: 'تحصيل من عميل', transfers: 'التحويلات البنكية', expenses: 'المصروفات', settle: 'التسوية اليومية', reports: 'التقارير', settings: 'الإعدادات', route: 'خط السير', returns: 'المرتجعات' };

async function render() {
  const [, name = 'home', arg] = location.hash.slice(1).split('/');
  const fn = routes[name] || home;
  const top = ['home', 'doc', 'customers', 'stock', 'more'].includes(name);
  $('#back').classList.toggle('hidden', name === 'home');
  $('#title').textContent = name === 'doc' ? DOC[arg || 'sell']?.title : TITLES[name] || '';
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.r === name || (name !== 'doc' && !top && a.dataset.r === 'more')));
  bind = null;
  try { view.innerHTML = (await fn(arg)) || ''; } catch (e) { console.error(e); view.innerHTML = `<div class="empty red">خطأ: ${esc(e.message)}</div>`; }
  if (name === 'doc') updateTotals();
  view.scrollTop = 0;
  updateNet();
}
window.addEventListener('hashchange', render);
const rerender = () => { const y = view.scrollTop; return render().then(() => (view.scrollTop = y)); };

function updateNet() {
  const n = pendingCount();
  const el = $('#net');
  el.className = 'net' + (navigator.onLine ? ' on' : '');
  el.title = (navigator.onLine ? 'متصل' : 'بدون إنترنت') + (n ? ` • ${n} بانتظار المزامنة` : '');
}
window.addEventListener('online', updateNet);
window.addEventListener('offline', updateNet);

// ================= الأحداث العامة =================
const A = {}; // الإجراءات: data-act
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el && A[el.dataset.act]) guard(A[el.dataset.act])(el, e);
});
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.k && bind) {
    bind[el.dataset.k] = el.hasAttribute('data-num') ? num(el.value) : el.value;
    if (draft && location.hash.startsWith('#/doc/')) updateTotals();
  }
  if (el.classList.contains('q') && draft) lineQty(+el.dataset.i, num(el.value));
});
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.classList.contains('p') && draft) return guard(linePrice)(+el.dataset.i, num(el.value), el);
  if (el.dataset.photo && bind) {
    bind[el.dataset.photo] = await photoToDataURL(el.files[0]);
    const pv = $('#pv-' + el.dataset.photo);
    if (pv) pv.innerHTML = bind[el.dataset.photo] ? `<img class="photo" src="${bind[el.dataset.photo]}">` : '';
  }
});
A.back = () => (history.length > 1 ? history.back() : go('#/home'));
A.go = (el) => go(el.dataset.to);

// ================= مكوّنات مشتركة =================
const chip = (act, val, label, on, extra = '') => `<button class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${esc(val)}" ${extra}>${esc(label)}</button>`;
const bankFields = (o) => `
  <label>البنك / وسيلة التحويل</label>
  <select data-k="bank">${BANKS().map((b) => `<option ${o.bank === b ? 'selected' : ''}>${esc(b)}</option>`).join('')}</select>
  <label>رقم العملية / الإشعار *</label><input data-k="ref" value="${esc(o.ref || '')}" inputmode="text" placeholder="مثال: 123456789">
  <label>اسم المحوِّل</label><input data-k="payer" value="${esc(o.payer || '')}">
  <label>صورة إشعار التحويل</label><input type="file" accept="image/*" capture="environment" data-photo="photo">
  <div id="pv-photo">${o.photo ? `<img class="photo" src="${o.photo}">` : ''}</div>
  ${S.settings.companyAccounts ? `<div class="sm">حسابات الشركة: ${esc(S.settings.companyAccounts)}</div>` : ''}`;

function customerPicker(onPick, { walkin = false } = {}) {
  const m = modal(`<h3>اختر العميل</h3><input id="cp-q" placeholder="بحث بالاسم أو الهاتف" autofocus><div id="cp-l"></div>`);
  const draw = () => {
    const q = $('#cp-q', m).value.trim();
    const list = S.customers.filter((c) => !q || (c.name + (c.phone || '')).includes(q));
    $('#cp-l', m).innerHTML =
      (walkin && !q ? `<div class="item" data-id="walkin"><div class="grow t">👤 عميل نقدي (بدون حساب)</div></div>` : '') +
      list.map((c) => { const l = C.ledger(c.id); return `<div class="item" data-id="${c.id}"><div class="grow"><div class="t">${esc(c.name)}</div><small>${esc(c.address || '')}</small></div>${l.balance > 0 ? `<span class="badge ${l.overdue ? 'red' : 'amb'}">${fmt(l.balance)}</span>` : ''}</div>`; }).join('') +
      (!list.length ? '<div class="empty">لا يوجد عملاء</div>' : '');
  };
  $('#cp-q', m).addEventListener('input', draw);
  m.addEventListener('click', (e) => { const it = e.target.closest('.item'); if (it) { m.remove(); onPick(it.dataset.id); } });
  draw();
}

function productPicker(kind, onPick) {
  const showStock = kind !== 'load';
  const m = modal(`<div class="row between"><h3>اختر الأصناف</h3><button class="btn sm primary" id="pp-done">تم</button></div><input id="pp-q" placeholder="بحث بالاسم أو الباركود" autofocus><div id="pp-l"></div>`);
  const draw = () => {
    const q = $('#pp-q', m).value.trim();
    const sm = C.stockMap();
    const list = S.products.filter((p) => !q || p.name.includes(q) || (p.barcode || '') === q);
    $('#pp-l', m).innerHTML = list.map((p) => {
      const inDraft = draft?.lines.find((l) => l.pid === p.id);
      const av = sm[p.id] || 0;
      return `<div class="item" data-id="${p.id}"><div class="grow"><div class="t">${esc(p.name)}</div><small>${esc(p.unit || '')}${showStock ? ` • بالعربة: ${av}` : ''}</small></div>${inDraft ? `<span class="badge grn">× ${inDraft.qty}</span>` : ''}${DOC[kind].price ? `<b>${fmt(C.priceFor(p, C.custOf(draft.customerId), 1))}</b>` : ''}</div>`;
    }).join('') || '<div class="empty">لا توجد أصناف</div>';
  };
  $('#pp-q', m).addEventListener('input', draw);
  $('#pp-q', m).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { const p = S.products.find((x) => x.barcode === e.target.value.trim()); if (p) { onPick(p); e.target.value = ''; draw(); } }
  });
  m.addEventListener('click', (e) => {
    const it = e.target.closest('.item');
    if (it) { onPick(C.prodOf(it.dataset.id)); draw(); }
  });
  $('#pp-done', m).onclick = () => { m.remove(); rerender(); };
  draw();
}

// ================= الرئيسية =================
function home() {
  const R = C.dayReport();
  const al = C.alerts();
  const closed = C.isDayClosed(today());
  const rt = S.customers.filter((c) => c.visitDay === weekday());
  const visited = new Set(S.visits.filter((v) => v.date === today()).map((v) => v.customerId));
  return `
  <div class="card"><div class="row between"><div><b>${esc(S.settings.repName || 'مرحباً بك')}</b><div class="sm">${DAYS[weekday()]} • ${today()}</div></div>${closed ? '<span class="badge grn">تمت التسوية</span>' : '<span class="badge amb">اليوم مفتوح</span>'}</div></div>
  <div class="grid g2" style="margin-bottom:10px">
    <div class="stat"><span>مبيعات اليوم (${R.invoices} فاتورة)</span><b>${money(R.sales)}</b></div>
    <div class="stat"><span>النقد المتوقع بيدك</span><b>${money(R.expectedCash)}</b></div>
    <div class="stat"><span>تحويلات بنكية</span><b>${money(R.bankTotal)}</b></div>
    <div class="stat"><span>مبيعات آجلة</span><b>${money(R.creditSales)}</b></div>
  </div>
  ${al.pendingTransfers ? `<a class="alert" href="#/transfers">⏳ ${al.pendingTransfers} تحويل بنكي قيد المراجعة</a>` : ''}
  ${al.overdue.length ? `<a class="alert red" href="#/customers" data-act="debtFilter">⚠️ ${al.overdue.length} عميل متأخر في السداد</a>` : ''}
  ${al.low.length ? `<a class="alert" href="#/stock">📉 ${al.low.length} صنف قارب على النفاد في العربة</a>` : ''}
  ${!S.products.length ? `<div class="alert">لا توجد أصناف بعد. أضفها من «الأصناف» أو حمّل بيانات تجريبية من الإعدادات.</div>` : ''}
  <div class="grid" style="margin-bottom:10px">
    <a class="tile" href="#/doc/sell"><i>🧾</i>فاتورة بيع</a>
    <a class="tile" href="#/collect"><i>💵</i>تحصيل</a>
    <a class="tile" href="#/doc/return"><i>↩️</i>مرتجع</a>
    <a class="tile" href="#/expenses"><i>⛽</i>مصروف</a>
    <a class="tile" href="#/route"><i>🗺️</i>خط السير</a>
    <a class="tile" href="#/settle"><i>✅</i>التسوية</a>
  </div>
  <div class="card"><div class="row between"><h3>خط سير اليوم (${rt.length})</h3><a href="#/route" class="sm">عرض الكل</a></div>
    ${rt.slice(0, 5).map((c) => `<a class="item" href="#/customer/${c.id}"><div class="grow t">${esc(c.name)}</div>${visited.has(c.id) ? '<span class="badge grn">تمت الزيارة</span>' : '<span class="badge">لم يُزَر</span>'}</a>`).join('') || '<div class="empty">لا توجد زيارات مجدولة اليوم</div>'}
  </div>`;
}
A.debtFilter = () => { form.custFilter = 'debt'; };

function more() {
  return `<div class="grid">
    <a class="tile" href="#/collect"><i>💵</i>تحصيل</a><a class="tile" href="#/returns"><i>↩️</i>المرتجعات</a><a class="tile" href="#/expenses"><i>⛽</i>المصروفات</a>
    <a class="tile" href="#/transfers"><i>🏦</i>التحويلات</a><a class="tile" href="#/settle"><i>✅</i>التسوية اليومية</a><a class="tile" href="#/reports"><i>📊</i>التقارير</a>
    <a class="tile" href="#/route"><i>🗺️</i>خط السير</a><a class="tile" href="#/products"><i>🏷️</i>الأصناف والأسعار</a><a class="tile" href="#/settings"><i>⚙️</i>الإعدادات</a>
  </div>`;
}

// ================= المستندات (بيع/مرتجع/شحن...) =================
function newDraft(kind, customerId = null) {
  const d = { kind, customerId, lines: [], discount: 0, cash: 0, bank: 0, payMode: 'cash', ref: '', payer: '', photo: '', note: '', mode: 'credit', reason: '', loc: null };
  d.bankName = BANKS()[0] || '';
  if (kind === 'sell') getLocation().then((l) => (d.loc = l));
  return d;
}
function startDoc(kind, customerId = null) {
  if (!draft || draft.kind !== kind || customerId) draft = newDraft(kind, customerId);
  go('#/doc/' + kind);
}
A.newDoc = (el) => startDoc(el.dataset.kind, el.dataset.cid || null);
A.clearDraft = () => { draft = null; rerender(); };

function doc(kind = 'sell') {
  if (!DOC[kind]) kind = 'sell';
  if (!draft || draft.kind !== kind) draft = newDraft(kind);
  bind = draft;
  const d = draft, meta = DOC[kind];
  const cust = d.customerId ? C.custOf(d.customerId) : null;
  const sm = C.stockMap();
  const lead = meta.cust
    ? `<div class="card row between"><div><small>العميل</small><div class="b">${cust ? esc(cust.name) : '<span class="red">لم يُحدد</span>'}</div>${cust && cust.id !== 'walkin' ? `<small>الرصيد الحالي: ${fmt(C.ledger(cust.id).balance)}</small>` : ''}</div><button class="btn sm" data-act="pickCust">${cust ? 'تغيير' : 'اختيار'}</button></div>`
    : '';
  const lines = d.lines.map((l, i) => `
    <div class="line" id="ln-${i}"><div><div class="b">${esc(l.name)}</div><small>${esc(l.unit || '')} • بالعربة: ${sm[l.pid] || 0}</small>
      ${kind === 'return' ? `<label style="display:inline-flex;gap:4px;align-items:center;margin-top:4px"><input type="checkbox" style="width:auto;margin:0" data-act="dmg" data-i="${i}" ${l.damaged ? 'checked' : ''}> تالف (لا يعود للمخزون)</label>` : ''}</div>
      <button class="btn sm" data-act="rmLine" data-i="${i}" style="height:34px">✕</button>
      <div class="ctl"><button data-act="dec" data-i="${i}">−</button><input class="q" type="number" inputmode="decimal" data-i="${i}" value="${l.qty}"><button data-act="inc" data-i="${i}">+</button>
        ${meta.price ? `<span class="sm">×</span><input class="p" type="number" inputmode="decimal" data-i="${i}" value="${l.price}">` : ''}</div>
      <div class="b" style="text-align:left">${meta.price ? `<span id="lt-${i}">${fmt(l.qty * l.price)}</span>` : ''}</div></div>`).join('');
  let foot = '';
  if (kind === 'sell') {
    foot = `<div class="card">
      <div class="tot"><span>المجموع</span><b id="sub">0</b></div>
      <label>خصم (${esc(S.settings.currency)})</label><input type="number" inputmode="decimal" data-k="discount" data-num value="${d.discount || ''}">
      <div class="tot big"><span>الإجمالي</span><span id="total">0</span></div></div>
    <div class="card"><h3>الدفع</h3>
      <div class="chips">${[['cash', 'كاش'], ['credit', 'آجل'], ['bank', 'تحويل بنكي'], ['mixed', 'مختلط']].map(([v, t]) => chip('payMode', v, t, d.payMode === v)).join('')}</div>
      <div class="row gap"><div class="grow"><label>كاش</label><input id="cash" type="number" inputmode="decimal" data-k="cash" data-num value="${d.cash || ''}" ${d.payMode !== 'mixed' ? 'readonly' : ''}></div>
      <div class="grow"><label>تحويل</label><input id="bankamt" type="number" inputmode="decimal" data-k="bank" data-num value="${d.bank || ''}" ${d.payMode !== 'mixed' ? 'readonly' : ''}></div></div>
      <div class="tot"><span>آجل (يُسجَّل على العميل)</span><b id="credit">0</b></div>
      <div id="bankbox" class="hidden">${bankFields({ bank: d.bankName, ref: d.ref, payer: d.payer, photo: d.photo }).replace('data-k="bank"', 'data-k="bankName"')}<div class="sm">التحويل يظهر «قيد المراجعة» حتى يؤكده المشرف/المحاسب.</div></div>
      <label>ملاحظات</label><input data-k="note" value="${esc(d.note)}"></div>`;
  } else if (kind === 'return') {
    foot = `<div class="card"><div class="tot big"><span>قيمة المرتجع</span><span id="total">0</span></div>
      <label>تسوية المرتجع</label><div class="chips">${chip('retMode', 'credit', 'خصم من دين العميل', d.mode === 'credit')}${chip('retMode', 'cash', 'رد نقدي للعميل', d.mode === 'cash')}</div>
      <label>سبب الارتجاع</label><input data-k="reason" value="${esc(d.reason)}" placeholder="تالف / منتهي / خطأ في الطلب ..."></div>`;
  } else {
    foot = `<div class="card"><div class="tot"><span>عدد الأصناف</span><b id="total">0</b></div><label>ملاحظات</label><input data-k="note" value="${esc(d.note)}"></div>`;
  }
  const html = `${lead}
    <div class="card"><div class="row between"><h3>الأصناف</h3><button class="btn sm primary" data-act="addProd">+ إضافة صنف</button></div>
      ${lines || '<div class="empty">لم تُضَف أصناف بعد</div>'}</div>
    ${foot}
    <button class="btn primary block" data-act="saveDoc" style="padding:14px">حفظ ${esc(meta.title)}</button>
    <button class="btn block" data-act="clearDraft" style="margin-top:8px">مسح المسودة</button>`;
  return html;
}

function updateTotals() {
  const d = draft;
  if (!d || !$('#total')) return;
  const meta = DOC[d.kind];
  const sm = C.stockMap();
  d.lines.forEach((l, i) => {
    const t = $('#lt-' + i); if (t) t.textContent = fmt(l.qty * l.price);
    const row = $('#ln-' + i);
    if (row) row.classList.toggle('warn', ['sell', 'unload', 'damage', 'sample'].includes(d.kind) && !S.settings.allowNegativeStock && l.qty > (sm[l.pid] || 0));
  });
  if (d.kind === 'sell') {
    const sub = d.lines.reduce((s, l) => s + l.qty * l.price, 0);
    const total = Math.max(0, sub - Math.min(d.discount || 0, sub));
    if (d.payMode === 'cash') { d.cash = total; d.bank = 0; }
    else if (d.payMode === 'credit') { d.cash = 0; d.bank = 0; }
    else if (d.payMode === 'bank') { d.cash = 0; d.bank = total; }
    if (d.payMode !== 'mixed') { $('#cash').value = d.cash || ''; $('#bankamt').value = d.bank || ''; }
    $('#sub').textContent = fmt(sub);
    $('#total').textContent = fmt(total);
    const credit = total - d.cash - d.bank;
    $('#credit').textContent = fmt(credit);
    $('#credit').className = credit < 0 ? 'red' : '';
    $('#bankbox').classList.toggle('hidden', !(d.bank > 0));
    d.total = total;
  } else if (meta.price) {
    $('#total').textContent = fmt(d.lines.reduce((s, l) => s + l.qty * l.price, 0));
  } else {
    $('#total').textContent = d.lines.length;
  }
}

function lineQty(i, q) {
  const l = draft.lines[i]; if (!l) return;
  l.qty = q;
  if (draft.kind === 'sell' && !l.manual) {
    l.price = C.priceFor(C.prodOf(l.pid), C.custOf(draft.customerId), q);
    const pi = $(`.p[data-i="${i}"]`); if (pi) pi.value = l.price;
  }
  updateTotals();
}
async function linePrice(i, p, el) {
  const l = draft.lines[i];
  if (draft.kind === 'sell') {
    const base = C.priceFor(C.prodOf(l.pid), C.custOf(draft.customerId), l.qty);
    if (p < base * (1 - S.settings.maxDiscountPct / 100) && !(await needPin(`السعر أقل من الحد المسموح (${S.settings.maxDiscountPct}%). أدخل الرقم السري للمشرف`))) { el.value = l.price; return; }
  }
  l.price = p; l.manual = true;
  updateTotals();
}
A.inc = (el) => stepQty(+el.dataset.i, 1);
A.dec = (el) => stepQty(+el.dataset.i, -1);
function stepQty(i, step) {
  const l = draft.lines[i];
  const q = Math.max(0, +(l.qty + step).toFixed(3));
  const inp = $(`.q[data-i="${i}"]`); if (inp) inp.value = q;
  lineQty(i, q);
}
A.rmLine = (el) => { draft.lines.splice(+el.dataset.i, 1); rerender(); };
A.dmg = (el) => { draft.lines[+el.dataset.i].damaged = el.checked; };
A.payMode = (el) => { draft.payMode = el.dataset.v; rerender(); };
A.retMode = (el) => { draft.mode = el.dataset.v; rerender(); };
A.pickCust = () => customerPicker((id) => {
  draft.customerId = id;
  const c = C.custOf(id);
  draft.lines.forEach((l) => { if (!l.manual) l.price = C.priceFor(C.prodOf(l.pid), c, l.qty); });
  rerender();
}, { walkin: true });
A.addProd = () => {
  const d = draft;
  if (DOC[d.kind].cust && !d.customerId) return toast('اختر العميل أولاً', true);
  productPicker(d.kind, (p) => {
    const ex = d.lines.find((l) => l.pid === p.id);
    if (ex) { ex.qty += 1; if (d.kind === 'sell' && !ex.manual) ex.price = C.priceFor(p, C.custOf(d.customerId), ex.qty); }
    else d.lines.push({ pid: p.id, name: p.name, unit: p.unit, qty: 1, price: DOC[d.kind].price ? C.priceFor(p, C.custOf(d.customerId), 1) : 0 });
  });
};

A.saveDoc = async () => {
  const d = draft, k = d.kind;
  if (DOC[k].cust && !d.customerId) return toast('اختر العميل', true);
  if (k === 'sell') {
    const inv = await C.createInvoice({
      customerId: d.customerId, lines: d.lines, discount: d.discount, cash: d.cash, bank: d.bank,
      bankInfo: { bank: d.bankName, ref: d.ref, payer: d.payer, photo: d.photo }, note: d.note, loc: d.loc,
    });
    draft = null; toast('تم حفظ الفاتورة'); go('#/invoice/' + inv.id);
  } else if (k === 'return') {
    const r = await C.createReturn({ customerId: d.customerId, lines: d.lines, mode: d.mode, reason: d.reason });
    draft = null; toast('تم حفظ المرتجع ' + r.no); go('#/returns');
  } else {
    const x = await C.createStockDoc({ type: k, lines: d.lines, note: d.note });
    draft = null; toast('تم الحفظ ' + x.no); go('#/stock');
  }
};

// ================= الفاتورة والطباعة والمشاركة =================
function invoiceText(inv) {
  const c = C.custOf(inv.customerId);
  const bal = inv.customerId !== 'walkin' ? C.ledger(inv.customerId).balance : 0;
  const cu = S.settings.currency;
  return [
    S.settings.company, S.settings.phone && `هاتف: ${S.settings.phone}`, `فاتورة رقم: ${inv.no}`, `التاريخ: ${inv.date} ${inv.time}`, `العميل: ${inv.customerName}`, '------------------------',
    ...inv.lines.map((l) => `${l.name}\n  ${l.qty} × ${fmt(l.price)} = ${fmt(l.qty * l.price)}`), '------------------------',
    inv.discount ? `خصم: ${fmt(inv.discount)}` : '', `الإجمالي: ${fmt(inv.total)} ${cu}`,
    inv.cash ? `كاش: ${fmt(inv.cash)}` : '', inv.bank ? `تحويل بنكي: ${fmt(inv.bank)} (${inv.bankRef || ''})` : '', inv.credit ? `آجل: ${fmt(inv.credit)} (استحقاق ${inv.dueDate})` : '',
    bal > 0 ? `إجمالي المستحق عليكم: ${fmt(bal)} ${cu}` : '', `المندوب: ${S.settings.repName}`, 'شكراً لتعاملكم معنا',
  ].filter(Boolean).join('\n');
}
function invoiceHTML(inv) {
  const bal = inv.customerId !== 'walkin' ? C.ledger(inv.customerId).balance : 0;
  return `<h3>${esc(S.settings.company)}</h3>${S.settings.phone ? `<p>${esc(S.settings.phone)}</p>` : ''}<p class="b">فاتورة ${esc(inv.no)}</p><p>${inv.date} ${inv.time}</p><hr>
  <p style="text-align:right">العميل: ${esc(inv.customerName)}</p><hr>
  <table>${inv.lines.map((l) => `<tr><td colspan="2" class="b">${esc(l.name)}</td></tr><tr><td>${l.qty} × ${fmt(l.price)}</td><td class="n">${fmt(l.qty * l.price)}</td></tr>`).join('')}</table><hr>
  <table>${inv.discount ? `<tr><td>خصم</td><td class="n">${fmt(inv.discount)}</td></tr>` : ''}<tr class="b"><td>الإجمالي</td><td class="n">${fmt(inv.total)}</td></tr>
  ${inv.cash ? `<tr><td>كاش</td><td class="n">${fmt(inv.cash)}</td></tr>` : ''}${inv.bank ? `<tr><td>تحويل</td><td class="n">${fmt(inv.bank)}</td></tr>` : ''}${inv.credit ? `<tr><td>آجل</td><td class="n">${fmt(inv.credit)}</td></tr>` : ''}
  ${bal > 0 ? `<tr class="b"><td>المستحق عليكم</td><td class="n">${fmt(bal)}</td></tr>` : ''}</table><hr><p>المندوب: ${esc(S.settings.repName)}</p><p>شكراً لتعاملكم معنا</p>`;
}
function invoice(id) {
  const inv = S.invoices.find((i) => i.id === id);
  if (!inv) return '<div class="empty">الفاتورة غير موجودة</div>';
  const c = C.custOf(inv.customerId);
  return `<div class="card paper">${inv.status === 'cancelled' ? `<div style="text-align:center"><span class="stamp">ملغاة</span><div class="sm">${esc(inv.cancelReason)}</div></div>` : ''}${invoiceHTML(inv)}</div>
  <div class="grid g2"><button class="btn primary" data-act="shareInv" data-id="${id}">📤 مشاركة</button><button class="btn" data-act="printInv" data-id="${id}">🖨️ طباعة</button>
  ${c?.phone ? `<a class="btn" href="tel:${esc(c.phone)}">📞 اتصال</a>` : ''}<a class="btn" href="#/doc/sell" data-act="newDoc" data-kind="sell">+ فاتورة جديدة</a></div>
  ${inv.status === 'active' ? `<button class="btn block danger" style="margin-top:10px" data-act="cancelInv" data-id="${id}">إلغاء الفاتورة</button>` : ''}
  <div class="sm" style="margin-top:6px">${inv.loc ? `موقع الفاتورة: <a href="https://www.google.com/maps?q=${inv.loc.lat},${inv.loc.lng}" target="_blank">خريطة</a>` : ''}</div>`;
}
A.shareInv = (el) => { const inv = S.invoices.find((i) => i.id === el.dataset.id); return shareText('فاتورة ' + inv.no, invoiceText(inv)); };
A.printInv = (el) => printHTML(invoiceHTML(S.invoices.find((i) => i.id === el.dataset.id)));
A.cancelInv = async (el) => {
  if (!(await needPin('إلغاء الفاتورة يحتاج الرقم السري للمشرف'))) return;
  const reason = await ask('سبب الإلغاء (إلزامي)', { input: true });
  if (!reason) return;
  await C.cancelInvoice(el.dataset.id, reason);
  toast('تم إلغاء الفاتورة وإرجاع الكميات للعربة'); rerender();
};

// ================= العملاء =================
function customers() {
  form.custFilter ||= 'all';
  form.custQ ||= '';
  const f = form.custFilter;
  const rows = S.customers.map((c) => ({ c, l: C.ledger(c.id) }))
    .filter(({ c, l }) => (!form.custQ || (c.name + (c.phone || '')).includes(form.custQ)) && (f === 'all' || (f === 'debt' && l.balance > 0) || (f === 'late' && l.overdue > 0) || (f === 'today' && c.visitDay === weekday())));
  return `<div class="row gap"><input id="cq" placeholder="بحث بالاسم أو الهاتف" value="${esc(form.custQ)}"><button class="btn primary" style="margin-bottom:8px" data-act="editCust">+ عميل</button></div>
  <div class="chips">${[['all', 'الكل'], ['today', 'زيارات اليوم'], ['debt', 'عليهم ديون'], ['late', 'متأخرون']].map(([v, t]) => chip('custFilter', v, t, f === v)).join('')}</div>
  <div class="card">${rows.map(({ c, l }) => `<a class="item" href="#/customer/${c.id}"><div class="grow"><div class="t">${esc(c.name)} ${c.type === 'wholesale' ? '<span class="badge blu">جملة</span>' : ''}</div><small>${esc(c.address || c.phone || '')}</small></div>${l.balance > 0 ? `<span class="badge ${l.overdue ? 'red' : 'amb'}">${fmt(l.balance)}</span>` : '<span class="badge grn">0</span>'}</a>`).join('') || '<div class="empty">لا يوجد عملاء</div>'}</div>`;
}
A.custFilter = (el) => { form.custFilter = el.dataset.v; rerender(); };
document.addEventListener('input', (e) => { if (e.target.id === 'cq') { form.custQ = e.target.value; const pos = e.target.selectionStart; rerender().then(() => { const q = $('#cq'); q.focus(); q.setSelectionRange(pos, pos); }); } });

function customer(id) {
  const c = C.custOf(id);
  if (!c) return '<div class="empty">العميل غير موجود</div>';
  const l = C.ledger(id);
  const hist = [
    ...S.invoices.filter((i) => i.customerId === id).map((i) => ({ d: i.date + i.time, t: `فاتورة ${i.no}`, a: i.total, h: `#/invoice/${i.id}`, st: i.status === 'cancelled' ? 'ملغاة' : '' })),
    ...S.payments.filter((p) => p.customerId === id && p.kind === 'collection').map((p) => ({ d: p.date + p.time, t: `سند قبض ${p.no} (${p.method === 'bank' ? 'تحويل' : 'كاش'})`, a: -p.amount, h: `#/receipt/${p.id}`, st: p.status === 'pending' ? 'قيد المراجعة' : p.status === 'rejected' ? 'مرفوض' : '' })),
    ...S.returns.filter((r) => r.customerId === id).map((r) => ({ d: r.date + r.time, t: `مرتجع ${r.no}`, a: -r.total, h: '#/returns', st: '' })),
  ].sort((a, b) => (a.d < b.d ? 1 : -1)).slice(0, 25);
  return `<div class="card"><div class="row between"><div><div class="b" style="font-size:17px">${esc(c.name)}</div><small>${esc(c.address || '')}</small></div><button class="btn sm" data-act="editCust" data-id="${id}">تعديل</button></div>
    <div class="grid g2" style="margin-top:10px"><div class="stat"><span>الرصيد المستحق</span><b class="${l.balance > 0 ? 'red' : ''}">${money(l.balance)}</b></div><div class="stat"><span>متأخر السداد</span><b class="${l.overdue ? 'red' : ''}">${money(l.overdue)}</b></div></div>
    <div class="sm" style="margin-top:6px">${l.nextDue ? `أقرب استحقاق: ${l.nextDue} • ` : ''}${c.limit ? `سقف الدين: ${fmt(c.limit)}` : 'بدون سقف دين'}${l.pendingBank ? ` • تحويلات قيد المراجعة: ${fmt(l.pendingBank)}` : ''}</div></div>
  <div class="grid g2" style="margin-bottom:10px"><button class="btn primary" data-act="newDoc" data-kind="sell" data-cid="${id}">🧾 فاتورة بيع</button><button class="btn" data-act="collectFor" data-id="${id}">💵 تحصيل</button>
    <button class="btn" data-act="newDoc" data-kind="return" data-cid="${id}">↩️ مرتجع</button><button class="btn" data-act="noSale" data-id="${id}">🚫 زيارة بدون بيع</button>
    ${c.phone ? `<a class="btn" href="tel:${esc(c.phone)}">📞 ${esc(c.phone)}</a>` : ''}${c.loc ? `<a class="btn" target="_blank" href="https://www.google.com/maps?q=${c.loc.lat},${c.loc.lng}">📍 الموقع</a>` : `<button class="btn" data-act="saveLoc" data-id="${id}">📍 حفظ موقعه الآن</button>`}</div>
  <div class="card"><h3>آخر الحركات</h3>${hist.map((h) => `<a class="item" href="${h.h}"><div class="grow"><div class="t">${esc(h.t)}</div><small>${h.d.slice(0, 10)} ${h.st ? `• ${h.st}` : ''}</small></div><b class="${h.a < 0 ? 'grn' : ''}">${fmt(h.a)}</b></a>`).join('') || '<div class="empty">لا توجد حركات</div>'}</div>`;
}
A.collectFor = (el) => { form.collect = { customerId: el.dataset.id, method: 'cash', bank: BANKS()[0] }; go('#/collect'); };
A.saveLoc = async (el) => {
  const loc = await getLocation();
  if (!loc) return toast('تعذّر تحديد الموقع، فعّل GPS وصلاحية الموقع', true);
  const c = C.custOf(el.dataset.id); c.loc = loc; await DB.put('customers', c); toast('تم حفظ موقع العميل'); rerender();
};
A.noSale = (el) => {
  const reasons = ['عنده مخزون كافٍ', 'لا توجد سيولة', 'المحل مغلق', 'السعر مرتفع', 'يشتري من مورد آخر', 'أخرى'];
  const m = modal(`<h3>سبب عدم الشراء</h3><div class="chips">${reasons.map((r) => `<button class="chip" data-r="${r}">${r}</button>`).join('')}</div>`);
  m.addEventListener('click', guard(async (e) => {
    const r = e.target.dataset.r; if (!r) return;
    m.remove(); await C.logVisit({ customerId: el.dataset.id, result: 'nosale', reason: r, loc: await getLocation() }); toast('تم تسجيل الزيارة'); rerender();
  }));
};
A.editCust = (el) => {
  const c = el.dataset.id ? { ...C.custOf(el.dataset.id) } : { id: undefined, type: 'retail', limit: 0, opening: 0, visitDay: -1, creditDays: S.settings.creditDays };
  const m = modal(`<h3>${c.id ? 'تعديل عميل' : 'عميل جديد'}</h3>
    <label>الاسم *</label><input id="c-name" value="${esc(c.name || '')}"><label>الهاتف</label><input id="c-phone" inputmode="tel" value="${esc(c.phone || '')}">
    <label>العنوان</label><input id="c-addr" value="${esc(c.address || '')}"><label>نوع التسعير</label>
    <select id="c-type"><option value="retail" ${c.type === 'retail' ? 'selected' : ''}>قطاعي</option><option value="wholesale" ${c.type === 'wholesale' ? 'selected' : ''}>جملة</option></select>
    <div class="row gap"><div class="grow"><label>سقف الدين (0 = بلا سقف)</label><input id="c-lim" type="number" value="${c.limit || 0}"></div><div class="grow"><label>مهلة السداد (يوم)</label><input id="c-days" type="number" value="${c.creditDays || S.settings.creditDays}"></div></div>
    <label>يوم الزيارة الأسبوعي</label><select id="c-day"><option value="-1">بدون</option>${DAYS.map((d, i) => `<option value="${i}" ${+c.visitDay === i ? 'selected' : ''}>${d}</option>`).join('')}</select>
    ${c.id ? '' : `<label>رصيد سابق مستحق (افتتاحي)</label><input id="c-open" type="number" value="0">`}
    <button class="btn primary block" id="c-save">حفظ</button>`);
  $('#c-save', m).onclick = guard(async () => {
    const name = $('#c-name', m).value.trim(); if (!name) return toast('الاسم مطلوب', true);
    const o = { ...c, name, phone: $('#c-phone', m).value.trim(), address: $('#c-addr', m).value.trim(), type: $('#c-type', m).value, limit: num($('#c-lim', m).value), creditDays: num($('#c-days', m).value) || S.settings.creditDays, visitDay: +$('#c-day', m).value };
    if (!o.id) { o.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); o.opening = num($('#c-open', m).value); o.createdDate = today(); S.customers.push(o); }
    else S.customers[S.customers.findIndex((x) => x.id === o.id)] = o;
    await DB.put('customers', o); m.remove(); toast('تم الحفظ'); rerender();
  });
};

// ================= خط السير =================
function routeView() {
  form.routeDay ??= weekday();
  const day = form.routeDay;
  const list = S.customers.filter((c) => c.visitDay === day);
  const vis = S.visits.filter((v) => v.date === today());
  const doneOf = (id) => vis.find((v) => v.customerId === id);
  return `<div class="chips">${DAYS.map((d, i) => chip('routeDay', i, d, day === i)).join('')}</div>
  <div class="card">${list.map((c) => { const v = doneOf(c.id); const l = C.ledger(c.id); return `<div class="item"><div class="grow"><a class="t" href="#/customer/${c.id}" style="color:inherit;text-decoration:none">${esc(c.name)}</a><small>${esc(c.address || '')}${l.balance > 0 ? ` • عليه ${fmt(l.balance)}` : ''}</small></div>
    ${v ? `<span class="badge ${v.result === 'sale' ? 'grn' : 'amb'}">${v.result === 'sale' ? 'تم البيع' : 'بدون بيع'}</span>` : ''}
    ${c.loc ? `<a class="btn sm" target="_blank" href="https://www.google.com/maps/dir/?api=1&destination=${c.loc.lat},${c.loc.lng}">🧭</a>` : ''}<button class="btn sm primary" data-act="newDoc" data-kind="sell" data-cid="${c.id}">بيع</button></div>`; }).join('') || '<div class="empty">لا توجد زيارات في هذا اليوم. حدد «يوم الزيارة» في ملف العميل.</div>'}</div>
  <div class="card"><h3>زيارات اليوم (${vis.length})</h3>${vis.map((v) => `<div class="item"><div class="grow t">${esc(C.custOf(v.customerId)?.name || '')}</div><small>${v.time} ${v.result === 'nosale' ? '• ' + esc(v.reason) : ''}</small></div>`).join('') || '<div class="empty">لا توجد زيارات</div>'}</div>`;
}
A.routeDay = (el) => { form.routeDay = +el.dataset.v; rerender(); };

// ================= الأصناف والمخزون =================
function products() {
  const sm = C.stockMap();
  return `<button class="btn primary block" data-act="editProd" style="margin-bottom:10px">+ صنف جديد</button>
  <div class="card">${S.products.map((p) => `<div class="item" data-act="editProd" data-id="${p.id}"><div class="grow"><div class="t">${esc(p.name)}</div><small>${esc(p.unit || '')} • بالعربة ${sm[p.id] || 0}${p.tiers?.length ? ' • أسعار كميات' : ''}</small></div><div style="text-align:left"><b>${fmt(p.retail)}</b><br><small>جملة ${fmt(p.wholesale)}</small></div></div>`).join('') || '<div class="empty">لا توجد أصناف</div>'}</div>`;
}
A.editProd = async (el) => {
  if (!(await needPin('تعديل الأصناف والأسعار يحتاج الرقم السري'))) return;
  const p = el.dataset.id ? { ...C.prodOf(el.dataset.id) } : { unit: 'قطعة', retail: 0, wholesale: 0, minQty: 0 };
  const m = modal(`<h3>${p.id ? 'تعديل صنف' : 'صنف جديد'}</h3>
    <label>الاسم *</label><input id="p-name" value="${esc(p.name || '')}"><div class="row gap"><div class="grow"><label>الوحدة</label><input id="p-unit" value="${esc(p.unit || '')}"></div><div class="grow"><label>الباركود</label><input id="p-bc" value="${esc(p.barcode || '')}"></div></div>
    <div class="row gap"><div class="grow"><label>سعر القطاعي</label><input id="p-ret" type="number" value="${p.retail || ''}"></div><div class="grow"><label>سعر الجملة</label><input id="p-whl" type="number" value="${p.wholesale || ''}"></div></div>
    <div class="row gap"><div class="grow"><label>التكلفة (للتسوية)</label><input id="p-cost" type="number" value="${p.cost || ''}"></div><div class="grow"><label>حد التنبيه</label><input id="p-min" type="number" value="${p.minQty || 0}"></div></div>
    <label>أسعار الكميات (كمية:سعر، مفصولة بفاصلة) مثال 12:9000, 24:8800</label><input id="p-tiers" value="${esc(C.tiersToText(p.tiers))}">
    <button class="btn primary block" id="p-save">حفظ</button>`);
  $('#p-save', m).onclick = guard(async () => {
    const name = $('#p-name', m).value.trim(); if (!name) return toast('الاسم مطلوب', true);
    const o = { ...p, name, unit: $('#p-unit', m).value.trim(), barcode: $('#p-bc', m).value.trim(), retail: num($('#p-ret', m).value), wholesale: num($('#p-whl', m).value), cost: num($('#p-cost', m).value), minQty: num($('#p-min', m).value), tiers: C.parseTiers($('#p-tiers', m).value) };
    if (!o.id) { o.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6); S.products.push(o); } else S.products[S.products.findIndex((x) => x.id === o.id)] = o;
    await DB.put('products', o); m.remove(); toast('تم الحفظ'); rerender();
  });
};

function stock() {
  const sm = C.stockMap();
  const labels = { load: 'شحن', unload: 'إرجاع للمخزن', damage: 'تالف', sample: 'عينات' };
  return `<div class="grid g2" style="margin-bottom:10px">${Object.keys(C.STOCK_DOCS).map((k) => `<button class="btn ${k === 'load' ? 'primary' : ''}" data-act="newDoc" data-kind="${k}">${C.STOCK_DOCS[k].label}</button>`).join('')}</div>
  <div class="card"><h3>مخزون العربة</h3><table><tr><th>الصنف</th><th class="n">الكمية</th></tr>${S.products.map((p) => { const q = sm[p.id] || 0; const low = p.minQty > 0 && q <= p.minQty; return `<tr><td>${esc(p.name)}</td><td class="n ${low ? 'red b' : ''}">${q} ${low ? '⚠️' : ''}</td></tr>`; }).join('') || '<tr><td>لا توجد أصناف</td></tr>'}</table></div>
  <div class="card"><h3>آخر حركات المخزن</h3>${[...S.loads].sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1)).slice(0, 15).map((l) => `<div class="item"><div class="grow"><div class="t">${labels[l.type]} • ${l.no}</div><small>${l.date} ${l.time} • ${l.lines.map((x) => `${x.name} ${x.qty}`).join('، ')}</small></div></div>`).join('') || '<div class="empty">لا توجد حركات</div>'}</div>`;
}

// ================= التحصيل =================
function collect() {
  form.collect ||= { customerId: null, method: 'cash', bank: BANKS()[0], amount: 0, ref: '', payer: '', photo: '', note: '' };
  const f = form.collect; bind = f;
  const c = f.customerId ? C.custOf(f.customerId) : null;
  const l = c ? C.ledger(c.id) : null;
  return `<div class="card row between"><div><small>العميل</small><div class="b">${c ? esc(c.name) : '<span class="red">لم يُحدد</span>'}</div>${l ? `<small>المستحق: ${fmt(l.balance)} ${l.overdue ? `• متأخر ${fmt(l.overdue)}` : ''}</small>` : ''}</div><button class="btn sm" data-act="pickCollectCust">${c ? 'تغيير' : 'اختيار'}</button></div>
  <div class="card"><label>المبلغ (${cur()})</label><input type="number" inputmode="decimal" data-k="amount" data-num value="${f.amount || ''}" style="font-size:20px">
  ${l && l.balance > 0 ? `<button class="btn sm" data-act="fullAmt">سداد كامل المستحق (${fmt(l.balance)})</button>` : ''}
  <label style="margin-top:8px">طريقة السداد</label><div class="chips">${chip('colMethod', 'cash', 'كاش', f.method === 'cash')}${chip('colMethod', 'bank', 'تحويل بنكي', f.method === 'bank')}</div>
  ${f.method === 'bank' ? bankFields(f) + '<div class="sm">يُسجَّل «قيد المراجعة» ولا يُخصم من الدين نهائياً إلا بعد تأكيد التحويل.</div>' : ''}
  <label>ملاحظات</label><input data-k="note" value="${esc(f.note || '')}"></div>
  <button class="btn primary block" data-act="saveCollect" style="padding:14px">حفظ وإصدار سند قبض</button>`;
}
A.pickCollectCust = () => customerPicker((id) => { form.collect.customerId = id; rerender(); });
A.colMethod = (el) => { form.collect.method = el.dataset.v; rerender(); };
A.fullAmt = () => { form.collect.amount = C.ledger(form.collect.customerId).balance; rerender(); };
A.saveCollect = async () => {
  const f = form.collect;
  const p = await C.createCollection({ customerId: f.customerId, amount: f.amount, method: f.method, bank: f.bank, ref: f.ref, payer: f.payer, photo: f.photo, note: f.note });
  form.collect = null; toast('تم تسجيل السداد'); go('#/receipt/' + p.id);
};
function receiptHTML(p) {
  const c = C.custOf(p.customerId), bal = C.ledger(p.customerId).balance;
  return `<h3>${esc(S.settings.company)}</h3><p class="b">سند قبض ${esc(p.no)}</p><p>${p.date} ${p.time}</p><hr>
  <table><tr><td>استلمنا من</td><td class="n">${esc(c?.name)}</td></tr><tr><td>المبلغ</td><td class="n b">${fmt(p.amount)} ${esc(S.settings.currency)}</td></tr>
  <tr><td>طريقة السداد</td><td class="n">${p.method === 'bank' ? 'تحويل بنكي' : 'كاش'}</td></tr>${p.method === 'bank' ? `<tr><td>البنك</td><td class="n">${esc(p.bank)}</td></tr><tr><td>رقم العملية</td><td class="n">${esc(p.ref)}</td></tr><tr><td>الحالة</td><td class="n">${{ pending: 'قيد المراجعة', confirmed: 'مؤكد', rejected: 'مرفوض' }[p.status]}</td></tr>` : ''}
  <tr><td>المتبقي عليكم</td><td class="n">${fmt(bal)}</td></tr></table><hr><p>المندوب: ${esc(S.settings.repName)}</p>`;
}
function receipt(id) {
  const p = S.payments.find((x) => x.id === id);
  if (!p) return '<div class="empty">غير موجود</div>';
  return `<div class="card paper">${receiptHTML(p)}${p.photo ? `<img class="photo" src="${p.photo}">` : ''}</div>
  <div class="grid g2"><button class="btn primary" data-act="shareRcp" data-id="${id}">📤 مشاركة</button><button class="btn" data-act="printRcp" data-id="${id}">🖨️ طباعة</button></div>`;
}
A.shareRcp = (el) => { const p = S.payments.find((x) => x.id === el.dataset.id); const c = C.custOf(p.customerId); return shareText('سند قبض ' + p.no, `${S.settings.company}\nسند قبض: ${p.no}\nالتاريخ: ${p.date}\nاستلمنا من: ${c?.name}\nالمبلغ: ${fmt(p.amount)} ${S.settings.currency}\nالطريقة: ${p.method === 'bank' ? `تحويل بنكي (${p.bank} - ${p.ref})` : 'كاش'}\nالمتبقي: ${fmt(C.ledger(p.customerId).balance)}\nالمندوب: ${S.settings.repName}`); };
A.printRcp = (el) => printHTML(receiptHTML(S.payments.find((x) => x.id === el.dataset.id)));

// ================= التحويلات =================
function transfers() {
  form.trf ||= 'pending';
  const all = S.payments.filter((p) => p.method === 'bank').sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
  const list = all.filter((p) => form.trf === 'all' || p.status === form.trf);
  const st = { pending: ['قيد المراجعة', 'amb'], confirmed: ['مؤكد', 'grn'], rejected: ['مرفوض', 'red'], cancelled: ['ملغى', ''] };
  return `<div class="chips">${[['pending', 'قيد المراجعة'], ['confirmed', 'مؤكدة'], ['rejected', 'مرفوضة'], ['all', 'الكل']].map(([v, t]) => chip('trfF', v, t, form.trf === v)).join('')}</div>
  ${list.map((p) => `<div class="card"><div class="row between"><div><div class="b">${fmt(p.amount)} ${cur()}</div><small>${esc(C.custOf(p.customerId)?.name || '')} • ${p.no}</small></div><span class="badge ${st[p.status][1]}">${st[p.status][0]}</span></div>
    <div class="sm">${esc(p.bank)} • رقم العملية: <b>${esc(p.ref)}</b> • ${p.date} ${p.time}${p.payer ? ` • المحوِّل: ${esc(p.payer)}` : ''}</div>
    ${p.photo ? `<img class="photo" src="${p.photo}" data-act="zoom">` : ''}
    ${p.status === 'pending' ? `<div class="row gap" style="margin-top:6px"><button class="btn primary sm grow" data-act="trfOk" data-id="${p.id}">تأكيد (طابق كشف البنك)</button><button class="btn danger sm grow" data-act="trfNo" data-id="${p.id}">رفض</button></div>` : ''}</div>`).join('') || '<div class="empty">لا توجد تحويلات</div>'}`;
}
A.trfF = (el) => { form.trf = el.dataset.v; rerender(); };
A.zoom = (el) => modal(`<img src="${el.src}" style="width:100%">`);
A.trfOk = async (el) => { if (await needPin('تأكيد التحويل (المحاسب/المشرف)')) { await C.setPaymentStatus(el.dataset.id, 'confirmed'); toast('تم تأكيد التحويل'); rerender(); } };
A.trfNo = async (el) => { if (!(await needPin('رفض التحويل'))) return; const n = await ask('سبب الرفض', { input: true }); if (n === null) return; await C.setPaymentStatus(el.dataset.id, 'rejected', n); toast('تم رفض التحويل'); rerender(); };

// ================= المرتجعات =================
function returnsList() {
  const list = [...S.returns].sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1)).slice(0, 40);
  return `<button class="btn primary block" data-act="newDoc" data-kind="return" style="margin-bottom:10px">+ مرتجع جديد</button>
  <div class="card">${list.map((r) => `<div class="item"><div class="grow"><div class="t">${esc(r.customerName)} • ${r.no}</div><small>${r.date} • ${r.lines.map((l) => `${esc(l.name)} ${l.qty}${l.damaged ? ' (تالف)' : ''}`).join('، ')} • ${r.mode === 'cash' ? 'رد نقدي' : 'خصم من الدين'}</small></div><b>${fmt(r.total)}</b></div>`).join('') || '<div class="empty">لا توجد مرتجعات</div>'}</div>`;
}

// ================= المصروفات =================
function expenses() {
  form.exp ||= { category: C.EXPENSE_CATS[0], amount: 0, note: '', photo: '' };
  bind = form.exp;
  const list = [...S.expenses].sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1)).slice(0, 30);
  return `<div class="card"><h3>تسجيل مصروف</h3><div class="chips">${C.EXPENSE_CATS.map((c) => chip('expCat', c, c, form.exp.category === c)).join('')}</div>
  <label>المبلغ (${cur()})</label><input type="number" inputmode="decimal" data-k="amount" data-num value="${form.exp.amount || ''}"><label>ملاحظة</label><input data-k="note" value="${esc(form.exp.note)}">
  <label>صورة الإيصال (اختياري)</label><input type="file" accept="image/*" capture="environment" data-photo="photo"><div id="pv-photo"></div>
  <button class="btn primary block" data-act="saveExp">حفظ المصروف</button></div>
  <div class="card"><h3>آخر المصروفات</h3>${list.map((e) => `<div class="item"><div class="grow"><div class="t">${esc(e.category)}</div><small>${e.date} ${esc(e.note || '')}</small></div><b>${fmt(e.amount)}</b></div>`).join('') || '<div class="empty">لا توجد مصروفات</div>'}</div>`;
}
A.expCat = (el) => { form.exp.category = el.dataset.v; rerender(); };
A.saveExp = async () => { await C.createExpense(form.exp); form.exp = null; toast('تم تسجيل المصروف'); rerender(); };

// ================= التسوية اليومية =================
function settle() {
  const date = today(), R = C.dayReport(date), closed = S.settlements.find((s) => s.date === date);
  form.settle ||= { actual: '', note: '', counts: {} };
  bind = form.settle;
  const rd = C.repDebt();
  const summary = `<div class="card"><h3>ملخص ${date}</h3>
    ${[['مبيعات (إجمالي)', R.sales], ['  كاش', R.cashSales], ['  تحويل بنكي', R.bankSales], ['  آجل', R.creditSales], ['تحصيل ديون كاش', R.cashColl], ['تحصيل ديون بتحويل', R.bankColl], ['مرتجعات (رد نقدي)', -R.cashRefunds], ['مرتجعات (خصم من الدين)', R.creditReturns], ['مصروفات', -R.expenses]].map(([t, v]) => `<div class="tot"><span>${t}</span><span>${fmt(v)}</span></div>`).join('')}
    <div class="tot big"><span>النقد المتوقع تسليمه</span><span>${fmt(R.expectedCash)}</span></div>
    <div class="sm">التحويلات البنكية (${fmt(R.bankTotal)}) لا تدخل في النقد، وتُراجع في شاشة «التحويلات».</div></div>`;
  const hist = [...S.settlements].sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 10);
  const histHtml = `<div class="card"><h3>سجل التسويات</h3>${hist.map((s) => `<div class="item"><div class="grow"><div class="t">${s.date}</div><small>نقد: ${fmt(s.actualCash)} من ${fmt(s.expectedCash)} • جرد: ${fmt(s.stockDiffValue)}</small></div><span class="badge ${s.repDelta > 0 ? 'red' : s.repDelta < 0 ? 'blu' : 'grn'}">${s.repDelta > 0 ? 'عجز ' : s.repDelta < 0 ? 'زيادة ' : 'مطابق'}${s.repDelta ? fmt(Math.abs(s.repDelta)) : ''}</span></div>`).join('') || '<div class="empty">لا توجد تسويات</div>'}
    <div class="tot b"><span>رصيد مديونية المندوب للشركة</span><span class="${rd > 0 ? 'red' : ''}">${fmt(rd)}</span></div></div>`;
  if (closed) return `${summary}<div class="card"><span class="badge grn">تمت تسوية اليوم</span><div class="tot"><span>النقد المسلَّم</span><b>${fmt(closed.actualCash)}</b></div><div class="tot"><span>فرق النقد</span><b class="${closed.cashDiff < 0 ? 'red' : ''}">${fmt(closed.cashDiff)}</b></div><div class="tot"><span>فرق الجرد (قيمة)</span><b class="${closed.stockDiffValue < 0 ? 'red' : ''}">${fmt(closed.stockDiffValue)}</b></div></div>${histHtml}`;
  const sm = C.stockMap();
  return `${summary}
  <div class="card"><h3>النقد الفعلي</h3><label>المبلغ النقدي الذي سلّمته (${cur()})</label><input type="number" inputmode="decimal" data-k="actual" value="${esc(form.settle.actual)}" style="font-size:20px"></div>
  <div class="card"><h3>جرد العربة</h3><div class="sm" style="margin-bottom:6px">اكتب الكمية الفعلية فقط للأصناف التي يختلف عددها، أو اتركها فارغة إن كانت مطابقة.</div>
  <table><tr><th>الصنف</th><th class="n">النظام</th><th class="n">الفعلي</th></tr>${S.products.filter((p) => sm[p.id]).map((p) => `<tr><td>${esc(p.name)}</td><td class="n">${sm[p.id]}</td><td class="n"><input class="cnt" data-pid="${p.id}" type="number" inputmode="decimal" placeholder="${sm[p.id]}" value="${esc(form.settle.counts[p.id] ?? '')}" style="width:80px;margin:0;padding:6px"></td></tr>`).join('')}</table></div>
  <div class="card"><label>ملاحظات</label><input data-k="note" value="${esc(form.settle.note)}"></div>
  <button class="btn primary block" data-act="closeDay" style="padding:14px">إقفال اليوم وتسوية الحساب</button>${histHtml}`;
}
document.addEventListener('input', (e) => { if (e.target.classList.contains('cnt')) form.settle.counts[e.target.dataset.pid] = e.target.value; });
A.closeDay = async () => {
  const f = form.settle;
  if (f.actual === '' || isNaN(num(f.actual))) return toast('أدخل النقد الفعلي (ولو صفر)', true);
  if (!(await ask('سيتم إقفال اليوم وتعديل مخزون العربة وفق الجرد، ولا يمكن التراجع. متابعة؟'))) return;
  const s = await C.closeDay({ actualCash: num(f.actual), counts: f.counts, note: f.note });
  form.settle = null;
  toast(s.repDelta > 0 ? 'تمت التسوية: يوجد عجز ' + fmt(s.repDelta) : 'تمت التسوية'); rerender();
};

// ================= التقارير =================
function reports() {
  form.rp ||= 'month';
  const t = today();
  const from = form.rp === 'today' ? t : form.rp === 'week' ? addDays(t, -6) : t.slice(0, 8) + '01';
  const R = C.periodReport(from, t);
  const debtors = S.customers.map((c) => ({ c, l: C.ledger(c.id) })).filter((x) => x.l.balance > 0).sort((a, b) => b.l.balance - a.l.balance);
  const comm = R.sales * (S.settings.commissionPct / 100);
  const tg = S.settings.monthlyTarget;
  const noSale = {}; R.visits.filter((v) => v.result === 'nosale').forEach((v) => (noSale[v.reason] = (noSale[v.reason] || 0) + 1));
  return `<div class="chips">${[['today', 'اليوم'], ['week', '7 أيام'], ['month', 'هذا الشهر']].map(([v, l]) => chip('rp', v, l, form.rp === v)).join('')}</div>
  <div class="grid g2" style="margin-bottom:10px"><div class="stat"><span>المبيعات (${R.count} فاتورة)</span><b>${money(R.sales)}</b></div><div class="stat"><span>التحصيل</span><b>${money(R.collections)}</b></div><div class="stat"><span>المرتجعات</span><b>${money(R.returns)}</b></div><div class="stat"><span>المصروفات</span><b>${money(R.expenses)}</b></div></div>
  <div class="card"><h3>العمولة والهدف</h3><div class="tot"><span>عمولة تقديرية (${S.settings.commissionPct}%)</span><b>${fmt(comm)}</b></div>${tg && form.rp === 'month' ? `<div class="tot"><span>تحقيق الهدف الشهري</span><b>${Math.round((R.sales / tg) * 100)}%</b></div>` : ''}</div>
  <div class="card"><h3>المبيعات حسب الصنف</h3><table>${R.byProduct.map(([n, o]) => `<tr><td>${esc(n)}</td><td class="n">${o.qty}</td><td class="n">${fmt(o.amount)}</td></tr>`).join('') || '<tr><td>لا بيانات</td></tr>'}</table></div>
  <div class="card"><h3>المبيعات حسب العميل</h3><table>${R.byCustomer.slice(0, 10).map(([n, a]) => `<tr><td>${esc(n)}</td><td class="n">${fmt(a)}</td></tr>`).join('') || '<tr><td>لا بيانات</td></tr>'}</table></div>
  <div class="card"><h3>ديون العملاء (${debtors.length})</h3><table><tr><th>العميل</th><th class="n">المستحق</th><th class="n">المتأخر</th></tr>${debtors.map(({ c, l }) => `<tr><td><a href="#/customer/${c.id}">${esc(c.name)}</a><br><small>${l.nextDue ? 'استحقاق ' + l.nextDue : ''}</small></td><td class="n">${fmt(l.balance)}</td><td class="n ${l.overdue ? 'red b' : ''}">${fmt(l.overdue)}</td></tr>`).join('') || '<tr><td>لا توجد ديون</td></tr>'}</table></div>
  <div class="card"><h3>أسباب عدم الشراء</h3>${Object.entries(noSale).map(([r, n]) => `<div class="tot"><span>${esc(r)}</span><b>${n}</b></div>`).join('') || '<div class="empty">لا توجد بيانات</div>'}</div>`;
}
A.rp = (el) => { form.rp = el.dataset.v; rerender(); };

// ================= الإعدادات =================
function settings() {
  const s = S.settings;
  form.set = { repName: s.repName, repCode: s.repCode, company: s.company, phone: s.phone, currency: s.currency, creditDays: s.creditDays, maxDiscountPct: s.maxDiscountPct, commissionPct: s.commissionPct, monthlyTarget: s.monthlyTarget, banks: s.banks.join('، '), companyAccounts: s.companyAccounts, serverUrl: s.serverUrl, serverToken: s.serverToken, pin: '', allowNegativeStock: s.allowNegativeStock };
  bind = form.set;
  const f = (k, label, type = 'text') => `<label>${label}</label><input data-k="${k}" ${type === 'number' ? 'type="number" data-num inputmode="decimal"' : ''} value="${esc(form.set[k] ?? '')}">`;
  return `<div class="card"><h3>بيانات المندوب والشركة</h3>${f('repName', 'اسم المندوب')}${f('repCode', 'رمز المندوب (يبدأ به رقم الفاتورة، مثل R1)')}${f('company', 'اسم الشركة (يظهر في الفاتورة)')}${f('phone', 'هاتف الشركة')}${f('currency', 'العملة')}</div>
  <div class="card"><h3>قواعد العمل</h3>${f('creditDays', 'مهلة السداد الافتراضية (يوم)', 'number')}${f('maxDiscountPct', 'أقصى خصم بدون موافقة المشرف (%)', 'number')}${f('commissionPct', 'نسبة العمولة (%)', 'number')}${f('monthlyTarget', 'الهدف الشهري للمبيعات', 'number')}
  <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" style="width:auto;margin:0" id="neg" ${form.set.allowNegativeStock ? 'checked' : ''}> السماح بالبيع بدون رصيد كافٍ في العربة</label></div>
  <div class="card"><h3>البنوك والتحويلات</h3>${f('banks', 'قائمة البنوك (مفصولة بفاصلة)')}${f('companyAccounts', 'حسابات الشركة المستلمة (للعرض أثناء التحويل)')}</div>
  <div class="card"><h3>الأمان</h3>${f('pin', 'رقم سري جديد للمشرف (اتركه فارغاً بدون تغيير)')}<div class="sm">الرقم الافتراضي 1234 — غيّره فوراً.</div></div>
  <div class="card"><h3>المزامنة مع الخادم (اختياري)</h3>${f('serverUrl', 'عنوان الخادم')}${f('serverToken', 'مفتاح الوصول')}<div class="sm">بانتظار المزامنة: ${pendingCount()} سجل</div><button class="btn block" data-act="syncNow" style="margin-top:6px">🔄 مزامنة الآن</button></div>
  <button class="btn primary block" data-act="saveSettings" style="padding:14px;margin-bottom:10px">حفظ الإعدادات</button>
  <div class="card"><h3>النسخ الاحتياطي</h3><div class="grid g2"><button class="btn" data-act="backup">⬇️ تصدير نسخة</button><label class="btn" style="margin:0">⬆️ استيراد<input type="file" accept=".json" id="restore" class="hidden"></label></div>
  <div class="sm" style="margin-top:6px">خذ نسخة احتياطية يومياً وأرسلها لنفسك أو للمكتب (واتساب/إيميل) تحسباً لضياع الجهاز.</div></div>
  <div class="card"><h3>أدوات</h3><button class="btn block" data-act="seed">تحميل بيانات تجريبية</button><button class="btn block danger" style="margin-top:8px" data-act="wipe">مسح كل البيانات</button></div>`;
}
A.saveSettings = async () => {
  const f = form.set;
  const patch = { repName: f.repName.trim(), repCode: (f.repCode || 'R1').trim(), company: f.company.trim(), phone: f.phone.trim(), currency: f.currency.trim() || 'ج.س', creditDays: f.creditDays || 14, maxDiscountPct: f.maxDiscountPct, commissionPct: f.commissionPct, monthlyTarget: f.monthlyTarget, banks: String(f.banks).split(/[,،]/).map((x) => x.trim()).filter(Boolean), companyAccounts: f.companyAccounts, serverUrl: f.serverUrl.trim(), serverToken: f.serverToken.trim(), allowNegativeStock: $('#neg').checked };
  if (f.pin) { if (!/^\d{4,8}$/.test(f.pin)) return toast('الرقم السري 4 إلى 8 أرقام', true); if (!(await needPin('أدخل الرقم السري الحالي'))) return; patch.pin = f.pin; }
  await C.saveSettings(patch); toast('تم حفظ الإعدادات'); rerender();
};
A.syncNow = async () => { toast('جارٍ المزامنة...'); await syncNow(); toast('تمت المزامنة'); rerender(); };
A.backup = async () => { await saveFile(`rep-backup-${today()}.json`, JSON.stringify(await DB.dump())); };
document.addEventListener('change', guard(async (e) => {
  if (e.target.id !== 'restore' || !e.target.files[0]) return;
  if (!(await needPin('استيراد نسخة يستبدل كل البيانات الحالية'))) return;
  await DB.restore(JSON.parse(await e.target.files[0].text())); await C.load(); toast('تم الاستيراد'); rerender();
}));
A.seed = async () => { if (S.products.length && !(await ask('ستُضاف بيانات تجريبية إلى بياناتك الحالية. متابعة؟'))) return; await C.seedDemo(); toast('تمت إضافة البيانات التجريبية'); go('#/home'); };
A.wipe = async () => {
  if (!(await needPin('مسح كل البيانات'))) return;
  if (!(await ask('سيتم حذف كل البيانات نهائياً. هل أنت متأكد؟'))) return;
  await DB.clearAll(); await C.load(); draft = null; toast('تم المسح'); go('#/home');
};

// ================= التشغيل =================
(async function boot() {
  await DB.open();
  await C.load();
  if (!location.hash) location.hash = '#/home';
  await render();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http') && !window.Capacitor?.isNativePlatform?.()) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
window.__app = { S, C, DB, go };
