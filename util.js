// أدوات مساعدة عامة
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const num = (v) => {
  // يقبل الأرقام العربية الهندية أيضاً
  const s = String(v ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[٫،]/g, '.').replace(/,/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};

export const fmt = (n) => (Math.round((+n || 0) * 100) / 100).toLocaleString('en-US');
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
export const today = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD بالتوقيت المحلي
export const nowTime = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
export const addDays = (date, n) => {
  const d = new Date(date + 'T12:00:00');
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString('sv-SE');
};
export const weekday = (date = today()) => new Date(date + 'T12:00:00').getDay(); // 0=الأحد
export const DAYS = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

let toastTimer;
export function toast(msg, bad = false) {
  let t = $('#toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.className = 'show' + (bad ? ' bad' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ''), 2600);
}

export function modal(html, { onClose } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `<div class="modal"><div class="modal-body">${html}</div></div>`;
  const close = () => {
    wrap.remove();
    onClose && onClose();
  };
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  document.body.appendChild(wrap);
  wrap.close = close;
  return wrap;
}

export function ask(message, { input = false, type = 'text', ok = 'تأكيد', placeholder = '', value = '' } = {}) {
  return new Promise((resolve) => {
    const m = modal(
      `<p class="ask-msg">${esc(message)}</p>
       ${input ? `<input id="ask-in" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" ${type === 'password' ? 'inputmode="numeric"' : ''}>` : ''}
       <div class="row gap"><button class="btn primary grow" id="ask-ok">${ok}</button><button class="btn grow" id="ask-no">إلغاء</button></div>`,
      { onClose: () => resolve(null) }
    );
    const inp = $('#ask-in', m);
    inp && inp.focus();
    $('#ask-ok', m).onclick = () => {
      const v = input ? inp.value : true;
      m.remove();
      resolve(v);
    };
    $('#ask-no', m).onclick = () => {
      m.remove();
      resolve(null);
    };
  });
}

export async function getLocation() {
  if (!navigator.geolocation) return null;
  return new Promise((res) =>
    navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: +p.coords.latitude.toFixed(6), lng: +p.coords.longitude.toFixed(6) }),
      () => res(null),
      { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }
    )
  );
}

export function photoToDataURL(file, max = 900) {
  return new Promise((resolve) => {
    if (!file) return resolve('');
    const r = new FileReader();
    r.onload = () => {
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = img.width * k;
        c.height = img.height * k;
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', 0.6));
      };
      img.onerror = () => resolve('');
      img.src = r.result;
    };
    r.readAsDataURL(file);
  });
}

const cap = () => window.Capacitor?.Plugins;

export async function shareText(title, text) {
  try {
    if (cap()?.Share) return await cap().Share.share({ title, text, dialogTitle: title });
    if (navigator.share) return await navigator.share({ title, text });
  } catch (e) {
    if (e && /cancel|abort/i.test(String(e.message || e.name))) return;
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('تم نسخ النص (المشاركة غير متاحة)');
  } catch {
    toast('تعذّرت المشاركة', true);
  }
}

export async function saveFile(name, text) {
  const C = cap();
  if (C?.Filesystem && C?.Share) {
    const r = await C.Filesystem.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
    return C.Share.share({ title: name, url: r.uri });
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// طباعة عبر iframe مخفي (مقاس 58 مم)
export function printHTML(html) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;right:0;bottom:0';
  document.body.appendChild(f);
  const d = f.contentDocument;
  d.open();
  d.write(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
    @page{size:58mm auto;margin:2mm}
    body{font-family:Tahoma,Arial,sans-serif;font-size:11px;width:54mm;margin:0;color:#000}
    h3,h4,p{margin:2px 0;text-align:center} table{width:100%;border-collapse:collapse}
    td,th{padding:1px 0;font-size:10.5px;text-align:right} .n{text-align:left}
    hr{border:0;border-top:1px dashed #000;margin:4px 0} .b{font-weight:bold}
  </style></head><body>${html}</body></html>`);
  d.close();
  setTimeout(() => {
    try {
      f.contentWindow.focus();
      f.contentWindow.print();
    } catch {
      toast('الطباعة المباشرة غير مدعومة على هذا الجهاز، استخدم المشاركة', true);
    }
    setTimeout(() => f.remove(), 3000);
  }, 250);
}
