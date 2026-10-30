// منطق العمل: المخزون، الأسعار، الفواتير، التحصيل، المرتجعات، التسوية
import * as DB from './db.js';
import { uid, today, nowTime, addDays, num } from './util.js';

export const S = {
  settings: {}, products: [], customers: [], invoices: [], returns: [], payments: [],
  expenses: [], visits: [], loads: [], moves: [], settlements: [], audit: [],
};

export const DEFAULTS = {
  repName: '', repCode: 'R1', company: 'اسم الشركة', phone: '', currency: 'ج.س',
  pin: '1234', creditDays: 14, maxDiscountPct: 5, allowNegativeStock: false,
  commissionPct: 1, monthlyTarget: 0, serverUrl: '', serverToken: '',
  banks: ['بنكك', 'فوري', 'أوكاش', 'بنك الخرطوم', 'أخرى'],
  companyAccounts: '', cnt: { INV: 0, RCP: 0, RET: 0, LD: 0, EXP: 0 },
};

export const WALKIN = { id: 'walkin', name: 'عميل نقدي', type: 'retail', limit: 0, opening: 0 };
export const STOCK_DOCS = {
  load: { label: 'شحن العربة', sign: 1 },
  unload: { label: 'إرجاع للمخزن الرئيسي', sign: -1 },
  damage: { label: 'تالف', sign: -1 },
  sample: { label: 'عينات مجانية', sign: -1 },
};
export const EXPENSE_CATS = ['وقود', 'صيانة', 'غسيل', 'رسوم/جبايات', 'وجبة/سفر', 'اتصالات', 'أخرى'];

const r2 = (n) => Math.round((+n || 0) * 100) / 100;
const MAP = { products: 'products', customers: 'customers', invoices: 'invoices', returns: 'returns', payments: 'payments', expenses: 'expenses', visits: 'visits', loads: 'loads', moves: 'moves', settlements: 'settlements', audit: 'audit' };

export async function load() {
  for (const k of Object.keys(MAP)) S[k] = await DB.all(MAP[k]);
  const m = await DB.get('meta', 'settings');
  S.settings = { ...DEFAULTS, ...(m?.v || {}), cnt: { ...DEFAULTS.cnt, ...(m?.v?.cnt || {}) } };
}

export async function saveSettings(patch) {
  S.settings = { ...S.settings, ...patch };
  await DB.put('meta', { id: 'settings', v: S.settings }, false);
}

export const custOf = (id) => (id === 'walkin' ? WALKIN : S.customers.find((c) => c.id === id));
export const prodOf = (id) => S.products.find((p) => p.id === id);

async function nextNo(kind) {
  const cnt = { ...S.settings.cnt };
  cnt[kind] = (cnt[kind] || 0) + 1;
  await saveSettings({ cnt });
  return `${S.settings.repCode}-${kind}-${String(cnt[kind]).padStart(5, '0')}`;
}

async function audit(action, ref, details = '') {
  const a = { id: uid(), at: new Date().toISOString(), action, ref, details };
  S.audit.push(a);
  await DB.put('audit', a);
}

// ---------- المخزون ----------
export function stockMap() {
  const m = {};
  for (const mv of S.moves) m[mv.pid] = (m[mv.pid] || 0) + mv.qty;
  return m;
}

const mv = (type, pid, qty, ref, date = today()) => ({ id: uid() + pid.slice(-3), date, ts: Date.now(), type, pid, qty, ref });

// ---------- الأسعار ----------
export function priceFor(product, customer, qty = 1) {
  let p = customer?.type === 'wholesale' ? product.wholesale || product.retail : product.retail;
  const tier = (product.tiers || []).filter((t) => qty >= t.min).sort((a, b) => b.min - a.min)[0];
  if (tier) p = tier.price;
  return +p || 0;
}
export const parseTiers = (txt) =>
  String(txt || '').split(/[,،\n]/).map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [a, b] = s.split(/[:=]/).map(num); return { min: a, price: b }; }).filter((t) => t.min > 0 && t.price > 0);
export const tiersToText = (tiers) => (tiers || []).map((t) => `${t.min}:${t.price}`).join(', ');

// ---------- حساب العميل (خصم الدفعات من الأقدم فالأحدث) ----------
const validCollection = (p) => p.kind === 'collection' && (p.method === 'cash' || p.status === 'confirmed');

export function ledger(cid) {
  const c = custOf(cid);
  const empty = { balance: 0, overdue: 0, nextDue: '', pendingBank: 0, items: [] };
  if (!c || cid === 'walkin') return empty;
  const items = [];
  let paid = 0;
  const open = +c.opening || 0;
  if (open > 0) items.push({ date: c.createdDate || '0000-00-00', due: c.createdDate || '0000-00-00', amt: open, ref: 'رصيد افتتاحي' });
  else paid += -open;
  for (const i of S.invoices) if (i.customerId === cid && i.status === 'active' && i.credit > 0) items.push({ date: i.date, due: i.dueDate || i.date, amt: i.credit, ref: i.no });
  let pendingBank = 0;
  for (const p of S.payments) {
    if (p.customerId !== cid) continue;
    if (p.kind === 'sale' && p.status === 'rejected') items.push({ date: p.date, due: p.date, amt: p.amount, ref: 'تحويل مرفوض ' + (p.ref || '') });
    if (validCollection(p)) paid += p.amount;
    if (p.kind === 'collection' && p.method === 'bank' && p.status === 'pending') pendingBank += p.amount;
  }
  for (const r of S.returns) if (r.customerId === cid && r.status === 'active' && r.mode === 'credit') paid += r.total;
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  let left = paid, total = 0, overdue = 0, nextDue = '';
  const t = today();
  for (const it of items) {
    total += it.amt;
    const take = Math.min(left, it.amt);
    left -= take;
    it.remain = r2(it.amt - take);
    if (it.remain > 0) {
      if (it.due < t) overdue += it.remain;
      else if (!nextDue || it.due < nextDue) nextDue = it.due;
    }
  }
  return { balance: r2(total - paid), overdue: r2(overdue), nextDue, pendingBank: r2(pendingBank), items };
}

export const refExists = (ref) => !!ref && S.payments.some((p) => p.ref && p.ref.trim() === ref.trim() && !['cancelled', 'rejected'].includes(p.status));

// ---------- الفواتير ----------
export async function createInvoice({ customerId, lines, discount = 0, cash = 0, bank = 0, bankInfo = {}, note = '', loc = null }) {
  const cust = custOf(customerId);
  if (!cust) throw new Error('اختر العميل');
  lines = lines.filter((l) => l.qty > 0);
  if (!lines.length) throw new Error('أضف صنفاً واحداً على الأقل');
  const sm = stockMap();
  if (!S.settings.allowNegativeStock)
    for (const l of lines) if ((sm[l.pid] || 0) < l.qty) throw new Error(`الكمية غير كافية في العربة: ${l.name} (المتاح ${sm[l.pid] || 0})`);
  const sub = r2(lines.reduce((s, l) => s + l.qty * l.price, 0));
  discount = Math.min(r2(discount), sub);
  const total = r2(sub - discount);
  cash = r2(cash); bank = r2(bank);
  const credit = r2(total - cash - bank);
  if (credit < 0) throw new Error('المبلغ المدفوع أكبر من إجمالي الفاتورة');
  if (credit > 0 && customerId === 'walkin') throw new Error('لا يوجد آجل للعميل النقدي، اختر عميلاً مسجلاً');
  if (credit > 0 && cust.limit > 0 && ledger(customerId).balance + credit > cust.limit)
    throw new Error(`تجاوز سقف الدين للعميل (${cust.limit})`);
  if (bank > 0) {
    if (!bankInfo.ref?.trim()) throw new Error('أدخل رقم عملية التحويل');
    if (refExists(bankInfo.ref)) throw new Error('رقم العملية مسجّل من قبل (تكرار)');
  }
  const id = uid(), date = today(), time = nowTime();
  const no = await nextNo('INV');
  const inv = {
    id, no, date, time, customerId, customerName: cust.name, lines, sub, discount, total, cash, bank, credit,
    dueDate: credit > 0 ? addDays(date, cust.creditDays || S.settings.creditDays) : '',
    status: 'active', note, loc, bankRef: bank > 0 ? bankInfo.ref.trim() : '',
  };
  const ops = [['invoices', inv], ...lines.map((l) => ['moves', mv('sale', l.pid, -l.qty, id)])];
  const moves = ops.filter((o) => o[0] === 'moves').map((o) => o[1]);
  const visit = { id: uid(), date, time, customerId, result: 'sale', ref: no, loc };
  ops.push(['visits', visit]);
  let pay = null;
  if (bank > 0) {
    pay = { id: uid(), no: inv.no, kind: 'sale', date, time, customerId, invoiceId: id, amount: bank, method: 'bank', bank: bankInfo.bank || '', ref: bankInfo.ref.trim(), payer: bankInfo.payer || '', photo: bankInfo.photo || '', status: 'pending' };
    ops.push(['payments', pay]);
  }
  await DB.batch(ops);
  S.invoices.push(inv); S.moves.push(...moves); S.visits.push(visit); pay && S.payments.push(pay);
  return inv;
}

export const isDayClosed = (date) => S.settlements.some((s) => s.date === date);

export async function cancelInvoice(id, reason) {
  const inv = S.invoices.find((i) => i.id === id);
  if (!inv || inv.status !== 'active') throw new Error('الفاتورة غير صالحة للإلغاء');
  if (!reason?.trim()) throw new Error('سبب الإلغاء مطلوب');
  if (isDayClosed(inv.date)) throw new Error('تمت تسوية يوم هذه الفاتورة ولا يمكن إلغاؤها');
  inv.status = 'cancelled'; inv.cancelReason = reason; inv.cancelAt = new Date().toISOString();
  const ops = [['invoices', inv]];
  const back = inv.lines.map((l) => mv('cancel', l.pid, l.qty, id));
  back.forEach((m) => ops.push(['moves', m]));
  for (const p of S.payments.filter((p) => p.invoiceId === id)) { p.status = 'cancelled'; ops.push(['payments', p]); }
  await DB.batch(ops);
  S.moves.push(...back);
  await audit('إلغاء فاتورة', inv.no, reason);
}

// ---------- التحصيل (سندات القبض) ----------
export async function createCollection({ customerId, amount, method, bank = '', ref = '', payer = '', photo = '', note = '' }) {
  if (!customerId || customerId === 'walkin') throw new Error('اختر العميل');
  amount = r2(amount);
  if (amount <= 0) throw new Error('أدخل مبلغاً صحيحاً');
  if (method === 'bank') {
    if (!ref.trim()) throw new Error('أدخل رقم عملية التحويل');
    if (refExists(ref)) throw new Error('رقم العملية مسجّل من قبل (تكرار)');
  }
  const p = {
    id: uid(), no: await nextNo('RCP'), kind: 'collection', date: today(), time: nowTime(), customerId,
    amount, method, bank, ref: ref.trim(), payer, photo, note, status: method === 'cash' ? 'confirmed' : 'pending',
  };
  await DB.put('payments', p);
  S.payments.push(p);
  return p;
}

export async function setPaymentStatus(id, status, note = '') {
  const p = S.payments.find((x) => x.id === id);
  if (!p) return;
  p.status = status; p.reviewNote = note; p.reviewedAt = new Date().toISOString();
  await DB.put('payments', p);
  await audit(status === 'confirmed' ? 'تأكيد تحويل' : 'رفض تحويل', p.no, `${p.amount} - ${p.ref} ${note}`);
}

// ---------- المرتجعات ----------
export async function createReturn({ customerId, lines, mode, reason = '' }) {
  const cust = custOf(customerId);
  if (!cust) throw new Error('اختر العميل');
  lines = lines.filter((l) => l.qty > 0);
  if (!lines.length) throw new Error('أضف صنفاً واحداً على الأقل');
  if (mode === 'credit' && customerId === 'walkin') mode = 'cash';
  const total = r2(lines.reduce((s, l) => s + l.qty * l.price, 0));
  const id = uid();
  const r = { id, no: await nextNo('RET'), date: today(), time: nowTime(), customerId, customerName: cust.name, lines, total, mode, reason, status: 'active' };
  const moves = lines.filter((l) => !l.damaged).map((l) => mv('return_in', l.pid, l.qty, id));
  await DB.batch([['returns', r], ...moves.map((m) => ['moves', m])]);
  S.returns.push(r); S.moves.push(...moves);
  return r;
}

// ---------- حركات المخزن (شحن / إرجاع / تالف / عينات) ----------
export async function createStockDoc({ type, lines, note = '' }) {
  const def = STOCK_DOCS[type];
  lines = lines.filter((l) => l.qty > 0);
  if (!lines.length) throw new Error('أضف صنفاً واحداً على الأقل');
  if (def.sign < 0) {
    const sm = stockMap();
    for (const l of lines) if ((sm[l.pid] || 0) < l.qty) throw new Error(`الكمية غير كافية: ${l.name} (المتاح ${sm[l.pid] || 0})`);
  }
  const id = uid();
  const d = { id, no: await nextNo('LD'), type, date: today(), time: nowTime(), lines, note };
  const moves = lines.map((l) => mv(type, l.pid, def.sign * l.qty, id));
  await DB.batch([['loads', d], ...moves.map((m) => ['moves', m])]);
  S.loads.push(d); S.moves.push(...moves);
  return d;
}

// ---------- المصروفات ----------
export async function createExpense({ category, amount, note = '', photo = '' }) {
  amount = r2(amount);
  if (amount <= 0) throw new Error('أدخل مبلغاً صحيحاً');
  const e = { id: uid(), date: today(), time: nowTime(), category, amount, note, photo };
  await DB.put('expenses', e);
  S.expenses.push(e);
  return e;
}

export async function logVisit({ customerId, result, reason = '', loc = null }) {
  const v = { id: uid(), date: today(), time: nowTime(), customerId, result, reason, loc };
  await DB.put('visits', v);
  S.visits.push(v);
}

// ---------- تقرير اليوم والتسوية ----------
export function dayReport(date = today()) {
  const inv = S.invoices.filter((i) => i.date === date && i.status === 'active');
  const col = S.payments.filter((p) => p.date === date && p.kind === 'collection' && p.status !== 'cancelled' && p.status !== 'rejected');
  const ret = S.returns.filter((r) => r.date === date && r.status === 'active');
  const exp = S.expenses.filter((e) => e.date === date);
  const sum = (a, f) => r2(a.reduce((s, x) => s + f(x), 0));
  const R = {
    date, invoices: inv.length,
    sales: sum(inv, (i) => i.total), cashSales: sum(inv, (i) => i.cash), bankSales: sum(inv, (i) => i.bank), creditSales: sum(inv, (i) => i.credit),
    cashColl: sum(col.filter((p) => p.method === 'cash'), (p) => p.amount), bankColl: sum(col.filter((p) => p.method === 'bank'), (p) => p.amount),
    returnsTotal: sum(ret, (r) => r.total), cashRefunds: sum(ret.filter((r) => r.mode === 'cash'), (r) => r.total),
    creditReturns: sum(ret.filter((r) => r.mode === 'credit'), (r) => r.total),
    expenses: sum(exp, (e) => e.amount),
    visits: S.visits.filter((v) => v.date === date).length,
    noSale: S.visits.filter((v) => v.date === date && v.result === 'nosale').length,
  };
  R.expectedCash = r2(R.cashSales + R.cashColl - R.cashRefunds - R.expenses);
  R.bankTotal = r2(R.bankSales + R.bankColl);
  return R;
}

const unitValue = (p) => p.cost > 0 ? p.cost : p.wholesale || p.retail || 0;

export async function closeDay({ date = today(), actualCash, counts, note = '' }) {
  if (isDayClosed(date)) throw new Error('تمت تسوية هذا اليوم من قبل');
  const R = dayReport(date);
  const sm = stockMap();
  const rows = [], adjust = [];
  let stockDiffValue = 0;
  for (const p of S.products) {
    const exp = sm[p.id] || 0;
    const act = counts[p.id] === undefined || counts[p.id] === '' ? exp : num(counts[p.id]);
    if (exp === 0 && act === 0) continue;
    const diff = act - exp;
    rows.push({ pid: p.id, name: p.name, expected: exp, actual: act, diff });
    if (diff !== 0) { adjust.push(mv('adjust', p.id, diff, 'settle-' + date)); stockDiffValue += diff * unitValue(p); }
  }
  actualCash = r2(actualCash);
  const cashDiff = r2(actualCash - R.expectedCash);
  const s = {
    id: uid(), date, closedAt: new Date().toISOString(), report: R, expectedCash: R.expectedCash, actualCash, cashDiff,
    stock: rows, stockDiffValue: r2(stockDiffValue), repDelta: r2(-cashDiff - stockDiffValue), note,
  };
  await DB.batch([['settlements', s], ...adjust.map((m) => ['moves', m])]);
  S.settlements.push(s); S.moves.push(...adjust);
  return s;
}

// مديونية المندوب للشركة (موجب = عليه، سالب = له)
export const repDebt = () => r2(S.settlements.reduce((s, x) => s + (x.repDelta || 0), 0));

// ---------- تقارير الفترات ----------
export function periodReport(from, to) {
  const inv = S.invoices.filter((i) => i.status === 'active' && i.date >= from && i.date <= to);
  const byProduct = {}, byCustomer = {};
  for (const i of inv) {
    byCustomer[i.customerName] = (byCustomer[i.customerName] || 0) + i.total;
    for (const l of i.lines) {
      const o = (byProduct[l.name] ||= { qty: 0, amount: 0 });
      o.qty += l.qty; o.amount += l.qty * l.price;
    }
  }
  const sales = r2(inv.reduce((s, i) => s + i.total, 0));
  const coll = S.payments.filter((p) => p.kind === 'collection' && validCollection(p) && p.date >= from && p.date <= to).reduce((s, p) => s + p.amount, 0);
  return {
    sales, count: inv.length, collections: r2(coll),
    expenses: r2(S.expenses.filter((e) => e.date >= from && e.date <= to).reduce((s, e) => s + e.amount, 0)),
    returns: r2(S.returns.filter((r) => r.status === 'active' && r.date >= from && r.date <= to).reduce((s, r) => s + r.total, 0)),
    byProduct: Object.entries(byProduct).sort((a, b) => b[1].amount - a[1].amount),
    byCustomer: Object.entries(byCustomer).sort((a, b) => b[1] - a[1]),
    visits: S.visits.filter((v) => v.date >= from && v.date <= to),
  };
}

// ---------- تنبيهات ----------
export function alerts() {
  const sm = stockMap();
  const low = S.products.filter((p) => p.minQty > 0 && (sm[p.id] || 0) <= p.minQty);
  const debtors = S.customers.map((c) => ({ c, l: ledger(c.id) }));
  return {
    low,
    overdue: debtors.filter((d) => d.l.overdue > 0),
    pendingTransfers: S.payments.filter((p) => p.method === 'bank' && p.status === 'pending').length,
  };
}

// ---------- بيانات تجريبية ----------
export async function seedDemo() {
  const P = (name, unit, retail, wholesale, tiers, minQty, barcode) => ({ id: uid() + Math.random().toString(36).slice(2, 5), name, unit, retail, wholesale, tiers, minQty, barcode, cost: Math.round(wholesale * 0.85) });
  const prods = [
    P('زيت طعام 1.5 لتر', 'عبوة', 9500, 9000, [{ min: 12, price: 8800 }], 5, '6001'),
    P('سكر 1 كجم', 'كيس', 2500, 2300, [{ min: 20, price: 2200 }], 10, '6002'),
    P('دقيق 2 كجم', 'كيس', 3500, 3300, [], 10, '6003'),
    P('أرز 5 كجم', 'كيس', 14000, 13200, [{ min: 5, price: 12800 }], 4, '6004'),
    P('شاي 250 جم', 'علبة', 4200, 3900, [], 6, '6005'),
    P('معجون طماطم', 'علبة', 1500, 1350, [{ min: 24, price: 1250 }], 12, '6006'),
  ];
  const day = weekday0();
  const C = (name, phone, address, type, limit, visitDay, opening) => ({ id: uid() + Math.random().toString(36).slice(2, 5), name, phone, address, type, limit, visitDay, opening, createdDate: today() });
  const custs = [
    C('بقالة النور', '0912345678', 'السوق الشعبي - أم درمان', 'retail', 200000, day, 0),
    C('سوبرماركت الأمل', '0923456789', 'شارع الستين - الخرطوم', 'wholesale', 1000000, day, 150000),
    C('مركز الوفاء التجاري', '0999123456', 'بحري - الحلفايا', 'wholesale', 0, (day + 1) % 7, 0),
    C('دكان الحاج أحمد', '0911000222', 'الكلاكلة', 'retail', 100000, -1, 0),
  ];
  await DB.batch([...prods.map((p) => ['products', p]), ...custs.map((c) => ['customers', c])]);
  S.products.push(...prods); S.customers.push(...custs);
  const lines = prods.map((p, i) => ({ pid: p.id, name: p.name, unit: p.unit, qty: [40, 100, 60, 30, 40, 80][i] }));
  await createStockDoc({ type: 'load', lines, note: 'شحنة افتتاحية (تجريبية)' });
}
const weekday0 = () => new Date().getDay();
