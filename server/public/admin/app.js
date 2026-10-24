'use strict';
// پنل مدیریت. تمام متن‌های دریافتی از سرور با textContent درج می‌شوند (جلوگیری از XSS).
(function () {
  const root = document.getElementById('app');
  let token = null;
  try { token = sessionStorage.getItem('adminToken'); } catch (_) { /* ignore */ }

  const STATUS = {
    pending_admin: 'در انتظار تأیید مدیر', pending_payment: 'در انتظار پرداخت آنلاین', pending: 'در انتظار بررسی',
    approved: 'تأیید شده (در حال انجام)', completed: 'تکمیل شده', rejected: 'رد شده', cancelled: 'لغو شده',
  };
  const TYPE = { buy: 'خرید', sell: 'فروش', delivery: 'تحویل فیزیکی' };
  const METHOD = { online: 'آنلاین', card: 'کارت‌به‌کارت' };
  const DELIVERY = { parsian: 'پارسیان', abshodeh: 'آب‌شده', masnoat: 'مصنوعات' };

  const fa = (n) => Number(n).toLocaleString('fa-IR');
  const gram = (sot) => `${fa(Math.floor(sot / 100))}/${String(sot % 100).padStart(2, '0').replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d])} گرم`;
  const toman = (n) => `${fa(n)} تومان`;
  const date = (ms) => new Intl.DateTimeFormat('fa-IR-u-ca-persian', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(ms));

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid ?? '')));
    return el;
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && token) { logout(); throw new Error('نشست منقضی شد؛ دوباره وارد شوید.'); }
    if (!res.ok) throw new Error(data.error || 'خطا');
    return data;
  }

  function logout() {
    token = null;
    try { sessionStorage.removeItem('adminToken'); } catch (_) { /* ignore */ }
    render();
  }

  function renderLogin(msg) {
    const user = h('input', { placeholder: 'نام کاربری', autocomplete: 'username' });
    const pass = h('input', { type: 'password', placeholder: 'رمز عبور', autocomplete: 'current-password' });
    const err = h('div', { class: 'err' }, msg || '');
    const btn = h('button', { class: 'primary', onclick: async () => {
      btn.disabled = true;
      try {
        const d = await api('POST', '/api/admin/login', { username: user.value, password: pass.value });
        token = d.token;
        try { sessionStorage.setItem('adminToken', token); } catch (_) { /* ignore */ }
        render();
      } catch (e) { err.textContent = e.message; btn.disabled = false; }
    } }, 'ورود');
    root.replaceChildren(h('div', { class: 'card login' }, h('h2', {}, 'ورود مدیر'), user, pass, err, btn));
  }

  const state = { tab: 'orders', filters: { status: '', type: '', method: '' } };

  async function render() {
    if (!token) return renderLogin();
    const tabs = [['orders', 'سفارش‌ها'], ['prices', 'قیمت‌ها'], ['users', 'مشتریان'], ['audit', 'گزارش عملیات']];
    const content = h('div', {}, 'در حال بارگذاری...');
    root.replaceChildren(
      h('header', {}, h('h1', {}, 'پنل مدیریت گالری زمرد'), h('button', { onclick: logout }, 'خروج')),
      h('main', {},
        h('div', { class: 'tabs' }, tabs.map(([k, label]) =>
          h('button', { class: state.tab === k ? 'active' : '', onclick: () => { state.tab = k; render(); } }, label))),
        content));
    try {
      const view = { orders: viewOrders, prices: viewPrices, users: viewUsers, audit: viewAudit }[state.tab];
      content.replaceChildren(await view());
    } catch (e) { content.replaceChildren(h('div', { class: 'err' }, e.message)); }
  }

  async function act(id, action, confirmText) {
    if (!confirm(confirmText)) return;
    try { await api('POST', `/api/admin/orders/${encodeURIComponent(id)}/${action}`); } catch (e) { alert(e.message); }
    render();
  }

  async function viewOrders() {
    const qs = new URLSearchParams(Object.entries(state.filters).filter(([, v]) => v)).toString();
    const { orders } = await api('GET', '/api/admin/orders' + (qs ? '?' + qs : ''));
    const sel = (key, opts) => h('select', { onchange: (e) => { state.filters[key] = e.target.value; render(); } },
      h('option', { value: '' }, 'همه'),
      Object.entries(opts).map(([v, l]) => h('option', { value: v, selected: state.filters[key] === v }, l)));
    const rows = orders.map((o) => {
      const buttons = [];
      if (o.type === 'buy' && o.method === 'card' && o.status === 'pending_admin') {
        buttons.push(h('button', { class: 'primary', onclick: () => act(o.id, 'approve', `پرداخت کارت‌به‌کارت ${toman(o.amountToman)} را تأیید می‌کنید؟ موجودی مشتری افزوده می‌شود.`) }, 'تأیید پرداخت'));
      }
      if (o.type !== 'buy' && o.status === 'pending') {
        buttons.push(h('button', { class: 'primary', onclick: () => act(o.id, 'approve', `درخواست را تأیید می‌کنید؟ ${gram(o.weightSot)} از موجودی مشتری کسر می‌شود.`) }, 'تأیید'));
      }
      if (['sell', 'delivery'].includes(o.type) && o.status === 'approved') {
        buttons.push(h('button', { class: 'primary', onclick: () => act(o.id, 'complete', o.type === 'sell' ? 'تسویه با مشتری انجام شده است؟' : 'تحویل فیزیکی انجام شده است؟') }, o.type === 'sell' ? 'ثبت تسویه' : 'ثبت تحویل'));
      }
      if (['pending', 'pending_admin', 'pending_payment'].includes(o.status)) {
        buttons.push(h('button', { class: 'danger', onclick: () => act(o.id, 'reject', 'درخواست رد شود؟') }, 'رد'));
      }
      return h('tr', {},
        h('td', {}, o.id, o.isDemo ? h('div', { class: 'demo' }, 'آزمایشی') : ''),
        h('td', {}, date(o.createdAt)),
        h('td', {}, `${o.customer.name} (کد ${o.customer.code})`, h('div', {}, o.customer.phone)),
        h('td', {}, TYPE[o.type], o.method ? ` - ${METHOD[o.method]}` : '', o.deliveryType ? h('div', {}, DELIVERY[o.deliveryType]) : ''),
        h('td', {}, gram(o.weightSot)),
        h('td', {}, o.amountToman ? toman(o.amountToman) : '-'),
        h('td', {}, h('span', { class: 'tag' }, STATUS[o.status] || o.status), o.details ? h('div', {}, o.details) : ''),
        h('td', {}, h('div', { class: 'row' }, buttons)));
    });
    return h('div', {},
      h('div', { class: 'row' }, 'وضعیت:', sel('status', STATUS), 'نوع:', sel('type', TYPE), 'روش پرداخت:', sel('method', METHOD)),
      h('div', { class: 'card table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['شناسه', 'تاریخ', 'مشتری', 'نوع', 'وزن', 'مبلغ', 'وضعیت', 'عملیات'].map((t) => h('th', {}, t)))),
        h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: 8 }, 'موردی نیست.'))))));
  }

  async function viewPrices() {
    const buy = h('input', { type: 'number', min: '1', placeholder: 'قیمت خرید هر گرم (تومان)' });
    const sell = h('input', { type: 'number', min: '1', placeholder: 'قیمت فروش هر گرم (تومان)' });
    const msg = h('div', {});
    const btn = h('button', { class: 'primary', onclick: async () => {
      try {
        await api('POST', '/api/admin/prices', { buy: Number(buy.value), sell: Number(sell.value) });
        msg.className = 'good'; msg.textContent = 'قیمت‌ها ثبت شد.';
        buy.value = ''; sell.value = '';
      } catch (e) { msg.className = 'err'; msg.textContent = e.message; }
    } }, 'ثبت قیمت');
    return h('div', { class: 'card' },
      h('h3', {}, 'ورود دستی قیمت'),
      h('div', { class: 'banner' }, 'قیمت‌ها دستی ثبت می‌شوند. اتصال به منبع قیمت زنده در مرحله بعد اضافه می‌شود.'),
      h('div', { class: 'row' }, buy, sell, btn), msg);
  }

  async function viewUsers() {
    const { users } = await api('GET', '/api/admin/users');
    return h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['کد', 'نام', 'نام پدر', 'موبایل', 'موجودی', 'عضویت'].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, fa(u.code)), h('td', {}, `${u.firstName} ${u.lastName}`), h('td', {}, u.fatherName),
        h('td', {}, u.phone), h('td', {}, gram(u.balanceSot)), h('td', {}, date(u.createdAt)))))));
  }

  async function viewAudit() {
    const { audit } = await api('GET', '/api/admin/audit');
    return h('div', { class: 'card table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['زمان', 'عامل', 'عملیات', 'هدف'].map((t) => h('th', {}, t)))),
      h('tbody', {}, audit.map((a) => h('tr', {}, h('td', {}, date(a.at)), h('td', {}, a.actor), h('td', {}, a.action), h('td', {}, a.target || '-'))))));
  }

  render();
})();
