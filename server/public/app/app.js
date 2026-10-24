'use strict';
// وب‌اپ مشتریان گالری زمرد. همه متن‌های دریافتی از سرور با textContent درج می‌شوند (جلوگیری از XSS).
// موجودی و وضعیت سفارش‌ها فقط از سرور خوانده می‌شود؛ این برنامه هیچ تصمیم مالی نمی‌گیرد.
(function () {
  const root = document.getElementById('app');
  const MIN_BUY_SOT = 30;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch (_) { /* ignore */ } },
  };
  let token = store.get('gz_token');
  let me = null;
  let cur = location.hash;
  function go(h) {
    if (cur === h) { route(); return; }
    cur = h;
    try { location.hash = h; } catch (_) { /* ignore */ }
    route();
  }

  // ---------- قالب‌بندی ----------
  const FA = '۰۱۲۳۴۵۶۷۸۹';
  const faDigits = (s) => String(s).replace(/\d/g, (d) => FA[d]);
  const group = (n) => String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '٬');
  const toman = (n, plus) => `\u2066${n < 0 ? '-' : plus && n > 0 ? '+' : ''}${faDigits(group(n))}\u2069 تومان`;
  const gram = (sot) => {
    const a = Math.abs(sot);
    return `${sot < 0 ? '-' : ''}${faDigits(Math.floor(a / 100) + '/' + String(a % 100).padStart(2, '0'))} گرم`;
  };
  const sotTxt = (sot) => `${faDigits(group(sot))} سوت`;
  const dateTxt = (ms) => {
    try { return new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms)); }
    catch (_) { return new Date(ms).toLocaleString(); }
  };
  const enDigits = (s) => String(s ?? '')
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660))
    .replace(/[٫،/]/g, '.').replace(/[٬,\s]/g, '');
  function parseAmount(t) { const s = enDigits(t); return /^\d{1,13}$/.test(s) ? Number(s) : null; }
  function parseGramsToSot(t) {
    const m = /^(\d{1,7})(?:\.(\d{1,2}))?$/.exec(enDigits(t));
    if (!m) return null;
    const sot = Number(m[1]) * 100 + (m[2] ? Number(m[2].padEnd(2, '0')) : 0);
    return sot > 0 ? sot : null;
  }
  const mulDiv = (a, b, c) => Number((BigInt(a) * BigInt(b)) / BigInt(c));

  const STATUS = {
    pending_admin: 'در انتظار تأیید مدیر', pending_payment: 'در انتظار پرداخت آنلاین', pending: 'در انتظار بررسی مدیر',
    approved: 'تأیید شده (در حال انجام)', completed: 'تکمیل شده', rejected: 'رد شده', cancelled: 'لغو شده',
  };
  const TYPE = { buy: 'خرید', sell: 'فروش', delivery: 'تحویل فیزیکی' };
  const DELIVERY = { parsian: 'پارسیان', abshodeh: 'آب‌شده', masnoat: 'مصنوعات' };
  const METHOD = { online: 'پرداخت آنلاین', card: 'کارت‌به‌کارت' };
  const CANCELABLE = ['pending', 'pending_admin', 'pending_payment'];

  // ---------- ابزار DOM ----------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid === false || kid == null) continue;
      el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }
  const row = (k, v, cls) => h('div', { class: 'row' }, h('span', { class: 'k' }, k), h('span', { class: 'v ' + (cls || '') }, v));
  const demoBanner = (txt) => h('div', { class: 'banner' }, h('span', {}, '🧪'),
    h('span', {}, txt || 'نسخه آزمایشی: داده‌ها و قیمت‌ها نمایشی است و برای امور مالی واقعی مناسب نیست.'));

  function toast(msg, bad) {
    document.querySelectorAll('.toast').forEach((x) => x.remove());
    const t = h('div', { class: 'toast' + (bad ? ' bad' : ''), role: 'status' }, msg);
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  function randKey() {
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function sheet(title, rows, confirmText) {
    return new Promise((resolve) => {
      const close = (v) => { ov.remove(); resolve(v); };
      const ov = h('div', { class: 'overlay', onclick: (e) => { if (e.target === ov) close(false); } },
        h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true' },
          h('h3', {}, title), rows,
          h('button', { class: 'primary', onclick: () => close(true) }, confirmText || 'تأیید'),
          h('button', { class: 'ghost', onclick: () => close(false) }, 'انصراف')));
      document.body.append(ov);
    });
  }

  // ---------- API ----------
  async function api(method, url, body, headers) {
    if (window.GZ_API) {
      try { return await window.GZ_API(method, url, body, headers || {}, token); }
      catch (e) {
        if (e.status === 401 && token) { doLogout(false); throw new Error('نشست منقضی شد؛ دوباره وارد شوید.'); }
        throw e;
      }
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(headers || {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (_) { throw new Error('ارتباط با سرور برقرار نشد. اینترنت را بررسی کنید.'); }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) { doLogout(false); throw new Error('نشست منقضی شد؛ دوباره وارد شوید.'); }
    if (!res.ok) throw new Error(data.error || 'خطای ناشناخته');
    return data;
  }

  function doLogout(callServer = true) {
    if (callServer && token) api('POST', '/api/auth/logout').catch(() => {});
    token = null; me = null; store.del('gz_token');
    go('');
  }

  // ---------- صفحه‌ها ----------
  function page(title, content, { back = true } = {}) {
    root.replaceChildren(h('div', { class: 'wrap' },
      h('header', { class: 'top' },
        back ? h('button', { class: 'icon-btn', 'aria-label': 'بازگشت', onclick: () => { go('#/'); } }, '→') : h('span', { class: 'side' }),
        h('h1', {}, title), h('span', { class: 'side' })),
      content));
    window.scrollTo(0, 0);
  }

  function viewLogin() {
    const phone = h('input', { type: 'tel', inputmode: 'numeric', dir: 'ltr', placeholder: '09123456789', autocomplete: 'tel', maxlength: '11' });
    const err = h('div', { class: 'err', role: 'alert' });
    const box = h('div', {});
    let sentPhone = null;

    const step1 = () => {
      box.replaceChildren(
        h('label', { class: 'f' }, 'شماره موبایل'), phone, err,
        h('button', { class: 'primary', id: 'send-otp', onclick: async (e) => {
          err.textContent = ''; e.target.disabled = true;
          try {
            const d = await api('POST', '/api/auth/request-otp', { phone: phone.value });
            sentPhone = phone.value; step2(d);
          } catch (ex) { err.textContent = ex.message; e.target.disabled = false; }
        } }, 'دریافت کد تأیید'));
    };

    const step2 = (d) => {
      const code = h('input', { type: 'tel', inputmode: 'numeric', dir: 'ltr', placeholder: '------', maxlength: '6', autocomplete: 'one-time-code' });
      const first = h('input', { placeholder: 'نام', autocomplete: 'given-name' });
      const last = h('input', { placeholder: 'نام خانوادگی', autocomplete: 'family-name' });
      const father = h('input', { placeholder: 'نام پدر' });
      err.textContent = '';
      box.replaceChildren(
        d.devCode ? h('div', { class: 'banner' }, h('span', {}, '🧪'),
          h('span', {}, 'حالت آزمایشی: پیامک واقعی ارسال نشد. کد تأیید: ', h('b', { id: 'dev-code' }, faDigits(d.devCode)))) : false,
        h('label', { class: 'f' }, `کد ارسال‌شده به ${faDigits(sentPhone)}`), code,
        h('div', { class: 'muted mt12' }, 'اگر اولین ورود شماست، اطلاعات زیر را هم وارد کنید:'),
        h('label', { class: 'f' }, 'نام'), first,
        h('label', { class: 'f' }, 'نام خانوادگی'), last,
        h('label', { class: 'f' }, 'نام پدر'), father, err,
        h('button', { class: 'primary', id: 'verify', onclick: async (e) => {
          err.textContent = ''; e.target.disabled = true;
          try {
            const r = await api('POST', '/api/auth/verify', {
              phone: sentPhone, code: code.value, firstName: first.value, lastName: last.value, fatherName: father.value,
            });
            token = r.token; me = r.user; store.set('gz_token', token);
            go('#/');
          } catch (ex) { err.textContent = ex.message; e.target.disabled = false; }
        } }, 'ورود'),
        h('button', { class: 'ghost', onclick: step1 }, 'تغییر شماره'));
    };

    step1();
    root.replaceChildren(h('div', { class: 'wrap login' },
      h('img', { class: 'logo', src: '/app/icon.svg', alt: '' }),
      h('h1', {}, 'گالری زمرد'),
      h('div', { class: 'muted mb16' }, 'ورود و ثبت‌نام مشتریان'),
      h('div', { class: 'card tr' }, box)));
  }

  async function viewHome() {
    page('گالری زمرد', h('div', { class: 'center' }, 'در حال بارگذاری...'), { back: false });
    let pf;
    try { pf = await api('GET', '/api/portfolio'); } catch (e) { page('گالری زمرد', h('div', { class: 'err' }, e.message), { back: false }); return; }
    const p = pf.price;
    const pnl = pf.pnlToman;
    const nav = (icon, label, hash) => h('button', { class: 'tile', onclick: () => { go(hash); } }, h('span', { class: 'ic' }, icon), label);
    page('گالری زمرد', h('div', {},
      demoBanner(p && !p.isDemo ? 'قیمت‌ها توسط مدیر ثبت شده است.' : undefined),
      h('div', { class: 'card' },
        h('div', { class: 'nm' }, `${me.firstName} ${me.lastName}`),
        h('div', { class: 'muted' }, `کد مشتری: ${faDigits(me.code)}`)),
      h('div', { class: 'card' },
        h('div', { class: 'big' }, h('div', { class: 'muted' }, 'موجودی طلا'),
          h('div', { class: 'n', id: 'balance' }, gram(pf.balanceSot)), h('div', { class: 'muted' }, sotTxt(pf.balanceSot))),
        hr(),
        p ? [row('قیمت خرید هر گرم', toman(p.buy)), row('قیمت فروش هر گرم', toman(p.sell))]
          : h('div', { class: 'muted' }, 'قیمت هنوز توسط مدیر ثبت نشده است.'),
        row('ارزش تقریبی دارایی', toman(pf.valueToman)),
        row('سود و زیان تقریبی', toman(pnl, true), pnl >= 0 ? 'pos' : 'neg'),
        pf.reservedSot > 0 ? row('در انتظار بررسی (رزرو)', gram(pf.reservedSot)) : false,
        p ? h('div', { class: 'muted mt6' }, `${p.isDemo ? 'قیمت آزمایشی (ورود دستی)' : 'قیمت ورود دستی'} - ${dateTxt(p.updatedAt)}`) : false),
      h('div', { class: 'grid' },
        nav('＋', 'خرید', '#/buy'), nav('－', 'فروش', '#/sell'), nav('🚚', 'تحویل فیزیکی', '#/delivery'),
        nav('📋', 'سوابق', '#/history'), nav('👤', 'پروفایل', '#/profile'))), { back: false });
  }
  const hr = () => h('hr');

  async function loadPortfolio() {
    try { return await api('GET', '/api/portfolio'); } catch (e) { toast(e.message, true); return null; }
  }

  async function viewBuy() {
    const pf = await loadPortfolio(); if (!pf) return;
    const p = pf.price;
    const amount = h('input', { inputmode: 'numeric', placeholder: 'مثلاً ۵٬۰۰۰٬۰۰۰', dir: 'ltr', id: 'amount' });
    const calc = h('div', { class: 'row' });
    const err = h('div', { class: 'err', role: 'alert' });
    let key = null;
    const update = () => {
      key = null; err.textContent = '';
      const a = parseAmount(amount.value);
      const w = a && p ? mulDiv(a, 100, p.buy) : null;
      calc.replaceChildren(h('span', { class: 'k' }, 'وزن محاسبه‌شده'),
        h('span', { class: 'v', id: 'calc' }, w == null ? '-' : `${gram(w)} (${sotTxt(w)})`));
      if (w != null && w < MIN_BUY_SOT) err.textContent = `حداقل خرید ${sotTxt(MIN_BUY_SOT)} است.`;
    };
    amount.addEventListener('input', update); update();

    const btn = h('button', { class: 'primary', id: 'buy-go', onclick: async () => {
      err.textContent = '';
      if (!p) { err.textContent = 'قیمت هنوز تعیین نشده است.'; return; }
      const a = parseAmount(amount.value);
      if (!a) { err.textContent = 'مبلغ معتبر وارد کنید.'; return; }
      const w = mulDiv(a, 100, p.buy);
      if (w < MIN_BUY_SOT) { err.textContent = `حداقل خرید ${sotTxt(MIN_BUY_SOT)} است.`; return; }
      const okc = await sheet('تأیید خرید', h('div', {},
        row('مبلغ', toman(a)), row('وزن', `${gram(w)} (${sotTxt(w)})`), row('قیمت هر گرم', toman(p.buy)),
        row('روش پرداخت', METHOD.card),
        h('div', { class: 'muted mt8' },
          'پس از ثبت، درخواست تا تأیید مدیر معلق می‌ماند و موجودی شما فقط پس از تأیید تغییر می‌کند.')), 'ثبت درخواست خرید');
      if (!okc) return;
      btn.disabled = true;
      key = key || randKey();
      try {
        const r = await api('POST', '/api/orders/buy', { amountToman: a, method: 'card' }, { 'Idempotency-Key': key });
        toast('درخواست خرید ثبت شد؛ در انتظار تأیید مدیر.');
        go('#/history'); void r;
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    } }, 'بررسی و ثبت خرید');

    page('خرید طلا', h('div', {},
      demoBanner(),
      h('div', { class: 'card' },
        p ? [row('قیمت خرید هر گرم', toman(p.buy)), row('حداقل خرید', `${sotTxt(MIN_BUY_SOT)} (${gram(MIN_BUY_SOT)})`)]
          : h('div', { class: 'err' }, 'قیمت هنوز توسط مدیر ثبت نشده است.')),
      h('label', { class: 'f' }, 'مبلغ به تومان'), amount,
      h('div', { class: 'card mt10' }, calc),
      h('label', { class: 'f' }, 'روش پرداخت'),
      h('div', { class: 'chips' },
        h('button', { class: 'chip on', disabled: false }, METHOD.card),
        h('button', { class: 'chip', disabled: true, title: 'به‌زودی' }, 'پرداخت آنلاین (به‌زودی)')),
      err, btn));
  }

  async function viewSell() {
    const pf = await loadPortfolio(); if (!pf) return;
    const p = pf.price;
    const w = h('input', { inputmode: 'decimal', placeholder: 'مثلاً ۱٫۲۵', dir: 'ltr', id: 'weight' });
    const calc = h('div', { class: 'row' });
    const err = h('div', { class: 'err', role: 'alert' });
    let key = null;
    const update = () => {
      key = null; err.textContent = '';
      const s = parseGramsToSot(w.value);
      calc.replaceChildren(h('span', { class: 'k' }, 'مبلغ تقریبی'),
        h('span', { class: 'v', id: 'calc' }, s && p ? toman(mulDiv(s, p.sell, 100)) : '-'));
      if (s && s > pf.availableSot) err.textContent = 'وزن بیشتر از موجودی قابل فروش است.';
    };
    w.addEventListener('input', update); update();
    const btn = h('button', { class: 'primary', id: 'sell-go', onclick: async () => {
      err.textContent = '';
      const s = parseGramsToSot(w.value);
      if (!s) { err.textContent = 'وزن معتبر به گرم وارد کنید (حداکثر دو رقم اعشار).'; return; }
      if (s > pf.availableSot) { err.textContent = 'وزن بیشتر از موجودی قابل فروش است.'; return; }
      if (!p) { err.textContent = 'قیمت هنوز تعیین نشده است.'; return; }
      const okc = await sheet('تأیید درخواست فروش', h('div', {},
        row('وزن', `${gram(s)} (${sotTxt(s)})`), row('قیمت فروش هر گرم', toman(p.sell)),
        row('مبلغ تقریبی', toman(mulDiv(s, p.sell, 100))),
        h('div', { class: 'muted mt8' },
          'این فقط یک درخواست است. مبلغ نهایی و تسویه پس از تأیید مدیر انجام می‌شود.')), 'ثبت درخواست فروش');
      if (!okc) return;
      btn.disabled = true; key = key || randKey();
      try {
        await api('POST', '/api/orders/sell', { weightSot: s }, { 'Idempotency-Key': key });
        toast('درخواست فروش ثبت شد.'); go('#/history');
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    } }, 'ثبت درخواست فروش');
    page('فروش طلا', h('div', {},
      demoBanner('فروش واقعی و تسویه پس از تأیید مدیر انجام می‌شود. در این نسخه فقط درخواست ثبت می‌شود.'),
      h('div', { class: 'card' }, row('موجودی قابل فروش', gram(pf.availableSot)), p ? row('قیمت فروش هر گرم', toman(p.sell)) : false),
      h('label', { class: 'f' }, 'وزن به گرم'), w,
      h('div', { class: 'card mt10' }, calc), err, btn));
  }

  async function viewDelivery() {
    const pf = await loadPortfolio(); if (!pf) return;
    let type = 'parsian'; let key = null;
    const w = h('input', { inputmode: 'decimal', placeholder: 'وزن به گرم', dir: 'ltr', id: 'weight' });
    const notes = h('textarea', { rows: '3', maxlength: '500', placeholder: 'توضیحات (اختیاری)' });
    const err = h('div', { class: 'err', role: 'alert' });
    const chips = h('div', { class: 'chips' });
    const drawChips = () => chips.replaceChildren(...Object.entries(DELIVERY).map(([k, l]) =>
      h('button', { class: 'chip' + (type === k ? ' on' : ''), 'data-type': k, onclick: () => { type = k; key = null; drawChips(); } }, l)));
    drawChips();
    w.addEventListener('input', () => { key = null; });
    const btn = h('button', { class: 'primary', id: 'del-go', onclick: async () => {
      err.textContent = '';
      const s = parseGramsToSot(w.value);
      if (!s) { err.textContent = 'وزن معتبر به گرم وارد کنید (حداکثر دو رقم اعشار).'; return; }
      if (s > pf.availableSot) { err.textContent = 'وزن بیشتر از موجودی قابل تحویل است.'; return; }
      const okc = await sheet('تأیید درخواست تحویل', h('div', {},
        row('نوع طلا', DELIVERY[type]), row('وزن', `${gram(s)} (${sotTxt(s)})`),
        notes.value.trim() ? row('توضیحات', notes.value.trim()) : false), 'ثبت درخواست تحویل');
      if (!okc) return;
      btn.disabled = true; key = key || randKey();
      try {
        const r = await api('POST', '/api/orders/delivery', { weightSot: s, deliveryType: type, notes: notes.value }, { 'Idempotency-Key': key });
        await sheet('درخواست ثبت شد', h('div', {}, row('شماره پیگیری', faDigits(r.order.tracking)), row('وضعیت', STATUS[r.order.status])), 'باشه');
        go('#/history');
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    } }, 'ثبت درخواست تحویل');
    page('تحویل فیزیکی', h('div', {},
      h('div', { class: 'card soft' },
        'مشتری گرامی در صورت تمایل میتوانید طلای خود را به صورت فیزیکی از گالری زمرد دریافت نمایید'),
      h('div', { class: 'card' }, row('موجودی قابل تحویل', gram(pf.availableSot))),
      h('label', { class: 'f' }, 'نوع طلا'), chips,
      h('label', { class: 'f' }, 'وزن به گرم'), w,
      h('label', { class: 'f' }, 'توضیحات'), notes, err, btn));
  }

  async function viewHistory() {
    page('سوابق', h('div', { class: 'center' }, 'در حال بارگذاری...'));
    let list;
    try { list = (await api('GET', '/api/orders')).orders; } catch (e) { page('سوابق', h('div', { class: 'err' }, e.message)); return; }
    let filter = '';
    const body = h('div', {});
    const chips = h('div', { class: 'chips' });
    const draw = () => {
      chips.replaceChildren(...[['', 'همه'], ...Object.entries(TYPE)].map(([k, l]) =>
        h('button', { class: 'chip' + (filter === k ? ' on' : ''), onclick: () => { filter = k; draw(); } }, l)));
      const items = list.filter((o) => !filter || o.type === filter);
      body.replaceChildren(...(items.length ? items.map(orderCard) : [h('div', { class: 'center' }, 'موردی ثبت نشده است.')]));
    };
    const orderCard = (o) => {
      const det = h('div', { class: 'details', hidden: true },
        row('شناسه', o.id),
        o.type === 'buy' && o.method ? row('روش پرداخت', METHOD[o.method]) : false,
        o.deliveryType ? row('نوع طلا', DELIVERY[o.deliveryType]) : false,
        o.tracking ? row('شماره پیگیری', faDigits(o.tracking)) : false,
        o.pricePerGram ? row('قیمت هر گرم', toman(o.pricePerGram)) : false,
        o.details ? row('جزئیات', o.details) : false,
        o.isDemo ? h('div', { class: 'muted' }, 'داده آزمایشی') : false,
        CANCELABLE.includes(o.status) ? h('button', { class: 'danger', onclick: async (e) => {
          e.stopPropagation();
          if (!(await sheet('لغو درخواست', h('div', {}, 'این درخواست لغو شود؟'), 'لغو درخواست'))) return;
          try { await api('POST', `/api/orders/${encodeURIComponent(o.id)}/cancel`); toast('درخواست لغو شد.'); viewHistory(); }
          catch (ex) { toast(ex.message, true); }
        } }, 'لغو درخواست') : false);
      return h('div', { class: 'card item', onclick: () => { det.hidden = !det.hidden; } },
        h('div', { class: 'top' },
          h('div', {}, h('b', {}, TYPE[o.type]), h('div', { class: 'muted' }, dateTxt(o.createdAt))),
          h('div', { class: 'tl' }, h('div', {}, gram(o.weightSot)),
            o.amountToman ? h('div', { class: 'muted' }, toman(o.amountToman)) : false)),
        h('div', { class: 'mt6' }, h('span', { class: 'tag' }, STATUS[o.status] || o.status)), det);
    };
    draw();
    page('سوابق', h('div', {}, demoBanner('سوابق نمایش‌داده‌شده آزمایشی هستند.'), chips, body));
  }

  async function viewProfile() {
    let u = me;
    try { u = (await api('GET', '/api/me')).user; me = u; } catch (e) { toast(e.message, true); }
    const first = h('input', { value: u.firstName }); const last = h('input', { value: u.lastName }); const father = h('input', { value: u.fatherName });
    const err = h('div', { class: 'err', role: 'alert' });
    page('پروفایل', h('div', {},
      h('div', { class: 'card' },
        row('کد مشتری', faDigits(u.code)), row('شماره موبایل', faDigits(u.phone)), row('نسخه برنامه', faDigits('0.3.0') + ' (وب - آزمایشی)')),
      h('div', { class: 'card' },
        h('label', { class: 'f' }, 'نام'), first, h('label', { class: 'f' }, 'نام خانوادگی'), last,
        h('label', { class: 'f' }, 'نام پدر'), father,
        h('div', { class: 'muted mt6' }, 'شماره موبایل و کد مشتری قابل ویرایش نیستند.'), err,
        h('button', { class: 'primary', id: 'save-profile', onclick: async () => {
          err.textContent = '';
          try {
            me = (await api('PATCH', '/api/me', { firstName: first.value, lastName: last.value, fatherName: father.value })).user;
            toast('اطلاعات ذخیره شد.');
          } catch (e) { err.textContent = e.message; }
        } }, 'ذخیره اطلاعات')),
      h('button', { class: 'ghost', id: 'logout', onclick: () => doLogout(true) }, 'خروج')));
  }

  // ---------- مسیریابی ----------
  const ROUTES = { '': viewHome, '#/': viewHome, '#/buy': viewBuy, '#/sell': viewSell, '#/delivery': viewDelivery, '#/history': viewHistory, '#/profile': viewProfile };
  async function route() {
    if (!token) return viewLogin();
    if (!me) {
      try { me = (await api('GET', '/api/me')).user; } catch (_) { return viewLogin(); }
    }
    (ROUTES[cur] || viewHome)();
  }
  window.addEventListener('hashchange', () => { if (location.hash !== cur) { cur = location.hash; route(); } });
  window.addEventListener('gz-refresh', route);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && token && (cur === '' || cur === '#/')) route(); });
  route();
})();
