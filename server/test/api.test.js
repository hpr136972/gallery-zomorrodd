'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { createApp } = require('../src/app');

const SECRET = 'test-gateway-secret';
let app; let base;

async function call(method, path, { token, body, idem } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
      ...(idem ? { 'Idempotency-Key': idem } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

let phoneSeq = 0;
async function register(name = 'علی') {
  const phone = '0912000' + String(1000 + phoneSeq++);
  const otp = await call('POST', '/api/auth/request-otp', { body: { phone } });
  assert.equal(otp.status, 200);
  const v = await call('POST', '/api/auth/verify', {
    body: { phone, code: otp.body.devCode, firstName: name, lastName: 'رضایی', fatherName: 'حسن' },
  });
  assert.equal(v.status, 200);
  return { phone, token: v.body.token, user: v.body.user };
}

let adminToken;
const idem = () => crypto.randomUUID();
const sign = (orderId, ref, amount) =>
  crypto.createHmac('sha256', SECRET).update(`${orderId}|${ref}|${amount}`).digest('hex');

test.before(async () => {
  app = createApp({
    production: false, port: 0, dbFile: ':memory:', demoMode: true, smsMode: 'dev', gatewaySecret: SECRET,
    pepper: 'test-pepper-123456', adminUser: 'admin', adminPassword: 'Admin-pass-12345', priceMaxAgeMin: 720, trustProxy: false,
  });
  base = 'http://127.0.0.1:' + (await app.listen(0, '127.0.0.1'));
  const l = await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'Admin-pass-12345' } });
  adminToken = l.body.token;
  const p = await call('POST', '/api/admin/prices', { token: adminToken, body: { buy: 5_000_000, sell: 4_950_000 } });
  assert.equal(p.status, 200);
  assert.equal(p.body.price.isDemo, true);
});
test.after(() => app.close());

test('ثبت‌نام: کد چهاررقمی یکتا و یک حساب برای هر موبایل', async () => {
  const a = await register();
  const b = await register();
  assert.match(a.user.code, /^\d{4}$/);
  assert.notEqual(a.user.code, b.user.code);
  // ورود مجدد با همان شماره، همان حساب را برمی‌گرداند
  const otp = await call('POST', '/api/auth/request-otp', { body: { phone: a.phone } }).catch(() => null);
  assert.equal(otp.status, 429); // محدودیت یک کد در دقیقه
  const count = app.db.prepare('SELECT COUNT(*) c FROM users WHERE phone=?').get(a.phone).c;
  assert.equal(count, 1);
});

test('OTP: کد غلط رد می‌شود و پس از ۵ تلاش قفل می‌شود', async () => {
  const phone = '09130000001';
  const otp = await call('POST', '/api/auth/request-otp', { body: { phone } });
  const wrong = otp.body.devCode === '123456' ? '654321' : '123456';
  for (let i = 0; i < 5; i++) {
    const r = await call('POST', '/api/auth/verify', { body: { phone, code: wrong, firstName: 'aa', lastName: 'bb', fatherName: 'cc' } });
    assert.equal(r.status, 400);
  }
  const r = await call('POST', '/api/auth/verify', { body: { phone, code: otp.body.devCode, firstName: 'aa', lastName: 'bb', fatherName: 'cc' } });
  assert.equal(r.status, 429);
  assert.equal(app.db.prepare('SELECT COUNT(*) c FROM users WHERE phone=?').get(phone).c, 0);
});

test('ثبت‌نام بدون نام‌ها رد می‌شود', async () => {
  const phone = '09130000002';
  const otp = await call('POST', '/api/auth/request-otp', { body: { phone } });
  const r = await call('POST', '/api/auth/verify', { body: { phone, code: otp.body.devCode } });
  assert.equal(r.status, 422);
});

test('خرید کارت‌به‌کارت: موجودی فقط پس از تأیید مدیر تغییر می‌کند', async () => {
  const u = await register();
  const key = idem();
  const o = await call('POST', '/api/orders/buy', { token: u.token, idem: key, body: { amountToman: 2_500_000, method: 'card' } });
  assert.equal(o.status, 201);
  assert.equal(o.body.order.weightSot, 50);
  assert.equal(o.body.order.status, 'pending_admin');
  assert.equal(o.body.order.isDemo, true);
  assert.equal((await call('GET', '/api/portfolio', { token: u.token })).body.balanceSot, 0);

  // ثبت مجدد با همان کلید، سفارش دوم نمی‌سازد
  const again = await call('POST', '/api/orders/buy', { token: u.token, idem: key, body: { amountToman: 2_500_000, method: 'card' } });
  assert.equal(again.body.order.id, o.body.order.id);
  assert.equal(app.db.prepare("SELECT COUNT(*) c FROM orders WHERE user_id=? AND type='buy'").get(u.user.id).c, 1);

  // کاربر عادی به API مدیر دسترسی ندارد
  assert.equal((await call('POST', `/api/admin/orders/${o.body.order.id}/approve`, { token: u.token })).status, 401);

  const ap = await call('POST', `/api/admin/orders/${o.body.order.id}/approve`, { token: adminToken });
  assert.equal(ap.status, 200);
  assert.equal(ap.body.order.status, 'completed');
  const pf = (await call('GET', '/api/portfolio', { token: u.token })).body;
  assert.equal(pf.balanceSot, 50);
  assert.equal(pf.costBasisToman, 2_500_000);
  // تأیید دوباره، موجودی را دوبار اضافه نمی‌کند
  assert.equal((await call('POST', `/api/admin/orders/${o.body.order.id}/approve`, { token: adminToken })).status, 409);
  assert.equal((await call('GET', '/api/portfolio', { token: u.token })).body.balanceSot, 50);
});

test('حداقل خرید ۳۰ سوت', async () => {
  const u = await register();
  const low = await call('POST', '/api/orders/buy', { token: u.token, idem: idem(), body: { amountToman: 1_499_999, method: 'card' } });
  assert.equal(low.status, 422);
  const okk = await call('POST', '/api/orders/buy', { token: u.token, idem: idem(), body: { amountToman: 1_500_000, method: 'card' } });
  assert.equal(okk.status, 201);
  assert.equal(okk.body.order.weightSot, 30);
  const bad = await call('POST', '/api/orders/buy', { token: u.token, idem: idem(), body: { amountToman: 1.5, method: 'card' } });
  assert.equal(bad.status, 422);
  const noKey = await call('POST', '/api/orders/buy', { token: u.token, body: { amountToman: 1_500_000, method: 'card' } });
  assert.equal(noKey.status, 400);
});

test('پرداخت آنلاین: امضا، مبلغ و تکرار بررسی می‌شود', async () => {
  const u = await register();
  const o = (await call('POST', '/api/orders/buy', { token: u.token, idem: idem(), body: { amountToman: 5_000_000, method: 'online' } })).body.order;
  assert.equal(o.status, 'pending_payment');
  // مدیر نمی‌تواند پرداخت آنلاین را دستی تأیید کند
  assert.equal((await call('POST', `/api/admin/orders/${o.id}/approve`, { token: adminToken })).status, 409);
  // امضای غلط
  assert.equal((await call('POST', '/api/payments/verify', { body: { orderId: o.id, ref: 'R1', amount: 5_000_000, signature: 'x'.repeat(64) } })).status, 403);
  // مبلغ نامطابق (با امضای درست)
  assert.equal((await call('POST', '/api/payments/verify', { body: { orderId: o.id, ref: 'R1', amount: 4_000_000, signature: sign(o.id, 'R1', 4_000_000) } })).status, 409);
  assert.equal((await call('GET', '/api/portfolio', { token: u.token })).body.balanceSot, 0);
  // پرداخت درست
  const good = await call('POST', '/api/payments/verify', { body: { orderId: o.id, ref: 'R1', amount: 5_000_000, signature: sign(o.id, 'R1', 5_000_000) } });
  assert.equal(good.status, 200);
  assert.equal((await call('GET', '/api/portfolio', { token: u.token })).body.balanceSot, 100);
  // تکرار همان تأیید: بدون افزایش مجدد
  const replay = await call('POST', '/api/payments/verify', { body: { orderId: o.id, ref: 'R1', amount: 5_000_000, signature: sign(o.id, 'R1', 5_000_000) } });
  assert.equal(replay.status, 200);
  assert.equal((await call('GET', '/api/portfolio', { token: u.token })).body.balanceSot, 100);
  // مرجع متفاوت برای همان سفارش
  assert.equal((await call('POST', '/api/payments/verify', { body: { orderId: o.id, ref: 'R2', amount: 5_000_000, signature: sign(o.id, 'R2', 5_000_000) } })).status, 409);
});

async function fund(u, amount = 5_000_000) {
  const o = (await call('POST', '/api/orders/buy', { token: u.token, idem: idem(), body: { amountToman: amount, method: 'card' } })).body.order;
  await call('POST', `/api/admin/orders/${o.id}/approve`, { token: adminToken });
}

test('فروش: رزرو، سقف موجودی، تأیید، تسویه و بهای تمام‌شده', async () => {
  const u = await register();
  await fund(u); // ۱۰۰ سوت
  const tooMuch = await call('POST', '/api/orders/sell', { token: u.token, idem: idem(), body: { weightSot: 101 } });
  assert.equal(tooMuch.status, 422);
  const s = await call('POST', '/api/orders/sell', { token: u.token, idem: idem(), body: { weightSot: 40 } });
  assert.equal(s.status, 201);
  assert.equal(s.body.order.amountToman, 1_980_000);
  let pf = (await call('GET', '/api/portfolio', { token: u.token })).body;
  assert.equal(pf.balanceSot, 100); // هنوز کم نشده
  assert.equal(pf.availableSot, 60); // اما رزرو شده
  // موجودی رزروشده برای فروش/تحویل دوباره قابل استفاده نیست
  assert.equal((await call('POST', '/api/orders/sell', { token: u.token, idem: idem(), body: { weightSot: 61 } })).status, 422);
  assert.equal((await call('POST', '/api/orders/delivery', { token: u.token, idem: idem(), body: { weightSot: 61, deliveryType: 'parsian' } })).status, 422);

  const ap = await call('POST', `/api/admin/orders/${s.body.order.id}/approve`, { token: adminToken });
  assert.equal(ap.body.order.status, 'approved');
  pf = (await call('GET', '/api/portfolio', { token: u.token })).body;
  assert.equal(pf.balanceSot, 60);
  assert.equal(pf.costBasisToman, 3_000_000); // ۴۰٪ از ۵٬۰۰۰٬۰۰۰ کم شد
  const done = await call('POST', `/api/admin/orders/${s.body.order.id}/complete`, { token: adminToken });
  assert.equal(done.body.order.status, 'completed');
  assert.equal((await call('POST', `/api/admin/orders/${s.body.order.id}/complete`, { token: adminToken })).status, 409);
});

test('لغو و رد درخواست، رزرو را آزاد می‌کند', async () => {
  const u = await register();
  await fund(u);
  const s = (await call('POST', '/api/orders/sell', { token: u.token, idem: idem(), body: { weightSot: 100 } })).body.order;
  assert.equal((await call('GET', '/api/portfolio', { token: u.token })).body.availableSot, 0);
  assert.equal((await call('POST', `/api/orders/${s.id}/cancel`, { token: u.token })).status, 200);
  assert.equal((await call('GET', '/api/portfolio', { token: u.token })).body.availableSot, 100);
  const d = (await call('POST', '/api/orders/delivery', { token: u.token, idem: idem(), body: { weightSot: 100, deliveryType: 'masnoat', notes: 'تست' } })).body.order;
  assert.match(d.tracking, /^GZ-/);
  await call('POST', `/api/admin/orders/${d.id}/reject`, { token: adminToken });
  assert.equal((await call('GET', '/api/portfolio', { token: u.token })).body.availableSot, 100);
});

test('تحویل فیزیکی: نوع نامعتبر رد می‌شود و کاربران به سفارش یکدیگر دسترسی ندارند', async () => {
  const a = await register();
  const b = await register();
  await fund(a);
  assert.equal((await call('POST', '/api/orders/delivery', { token: a.token, idem: idem(), body: { weightSot: 10, deliveryType: 'xyz' } })).status, 422);
  const d = (await call('POST', '/api/orders/delivery', { token: a.token, idem: idem(), body: { weightSot: 10, deliveryType: 'abshodeh' } })).body.order;
  assert.equal((await call('GET', `/api/orders/${d.id}`, { token: b.token })).status, 404);
  assert.equal((await call('POST', `/api/orders/${d.id}/cancel`, { token: b.token })).status, 404);
});

test('قیمت: فروش بیشتر از خرید رد می‌شود و فقط مدیر می‌تواند تغییر دهد', async () => {
  assert.equal((await call('POST', '/api/admin/prices', { token: adminToken, body: { buy: 100, sell: 200 } })).status, 422);
  assert.equal((await call('POST', '/api/admin/prices', { token: adminToken, body: { buy: 1.5, sell: 1 } })).status, 422);
  const u = await register();
  assert.equal((await call('POST', '/api/admin/prices', { token: u.token, body: { buy: 5_100_000, sell: 5_000_000 } })).status, 401);
  assert.equal((await call('GET', '/api/admin/orders')).status, 401);
});

test('ورود مدیر: رمز غلط رد می‌شود', async () => {
  assert.equal((await call('POST', '/api/admin/login', { body: { username: 'admin', password: 'wrong' } })).status, 401);
});

test('پنل مدیریت با هدرهای امنیتی سرو می‌شود', async () => {
  const res = await fetch(base + '/admin');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});
