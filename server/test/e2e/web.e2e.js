'use strict';
// تست سرتاسری وب‌اپ با مرورگر واقعی (Chromium + Playwright).
// اجرا:  PLAYWRIGHT_PATH=/مسیر/playwright node test/e2e/web.e2e.js   (یا پس از npm i playwright)
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { createApp } = require('../../src/app');

const SHOT_DIR = process.env.SHOT_DIR || '.';

(async () => {
  const app = createApp({
    production: false, port: 0, dbFile: ':memory:', demoMode: true, smsMode: 'dev', gatewaySecret: 'x',
    pepper: 'test-pepper-123456', adminUser: 'admin', adminPassword: 'Admin-pass-12345', priceMaxAgeMin: 720, trustProxy: false,
  });
  const port = await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${port}`;
  const j = async (method, url, body, token) => {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json() };
  };
  const admin = (await j('POST', '/api/admin/login', { username: 'admin', password: 'Admin-pass-12345' })).body.token;
  await j('POST', '/api/admin/prices', { buy: 5_000_000, sell: 4_950_000 }, admin);

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'fa-IR' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  const shot = (n) => page.screenshot({ path: path.join(SHOT_DIR, `shot-${n}.png`) });
  const step = (m) => console.log('✔', m);

  // --- ورود و ثبت‌نام ---
  const r0 = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(r0.status, 302);
  await page.goto(base + '/app/');
  assert.equal(await page.getAttribute('html', 'dir'), 'rtl');
  await page.fill('input[type=tel]', '09121234567');
  await page.click('#send-otp');
  await page.waitForSelector('#dev-code');
  await shot('1-otp');
  const devCode = (await page.textContent('#dev-code')).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0));
  await page.fill('input[placeholder="------"]', devCode);
  await page.fill('input[placeholder="نام"]', 'علی');
  await page.fill('input[placeholder="نام خانوادگی"]', 'رضایی');
  await page.fill('input[placeholder="نام پدر"]', 'حسن');
  await page.click('#verify');
  await page.waitForSelector('#balance');
  assert.match(await page.textContent('body'), /علی رضایی/);
  assert.match(await page.textContent('body'), /کد مشتری: [۰-۹]{4}/);
  assert.match(await page.textContent('#balance'), /۰\/۰۰ گرم/);
  step('ثبت‌نام و ورود با OTP، کد مشتری چهاررقمی');
  await shot('2-home');

  // --- خرید: حداقل ۳۰ سوت ---
  await page.click('.tile:has-text("خرید")');
  await page.fill('#amount', '۱٬۴۹۹٬۹۹۹');
  assert.match(await page.textContent('body'), /حداقل خرید/);
  await page.fill('#amount', '۱۰٬۰۰۰٬۰۰۰');
  assert.match(await page.textContent('#calc'), /۲\/۰۰ گرم/); // ۱۰M / ۵M = ۲ گرم
  await page.click('#buy-go');
  await page.waitForSelector('.sheet');
  await shot('3-buy-confirm');
  await page.click('.sheet button.primary');
  await page.waitForSelector('h1:has-text("سوابق")');
  await page.waitForSelector('.item');
  assert.match(await page.textContent('.item'), /در انتظار تأیید مدیر/);
  step('خرید کارت‌به‌کارت ثبت شد و تا تأیید مدیر معلق است');

  // موجودی هنوز صفر است
  await page.goto(base + '/app/#/');
  await page.waitForSelector('#balance');
  assert.match(await page.textContent('#balance'), /۰\/۰۰ گرم/);

  // --- تأیید مدیر (API) ---
  const orders = (await j('GET', '/api/admin/orders?status=pending_admin', null, admin)).body.orders;
  assert.equal(orders.length, 1);
  assert.equal((await j('POST', `/api/admin/orders/${orders[0].id}/approve`, null, admin)).status, 200);
  await page.reload();
  await page.waitForSelector('#balance');
  assert.match(await page.textContent('#balance'), /۲\/۰۰ گرم/);
  step('موجودی فقط پس از تأیید مدیر تغییر کرد');
  await shot('4-home-funded');

  // --- فروش ---
  await page.click('.tile:has-text("فروش")');
  await page.fill('#weight', '۳');
  assert.match(await page.textContent('body'), /بیشتر از موجودی/);
  await page.fill('#weight', '0.5');
  assert.match(await page.textContent('#calc'), /\u2066۲٬۴۷۵٬۰۰۰\u2069 تومان/);
  await page.click('#sell-go');
  await page.click('.sheet button.primary');
  await page.waitForSelector('.item');
  step('درخواست فروش ثبت شد و سقف موجودی اعمال شد');

  // --- تحویل فیزیکی ---
  await page.goto(base + '/app/#/delivery');
  await page.waitForSelector('#del-go');
  assert.match(await page.textContent('body'), /مشتری گرامی در صورت تمایل میتوانید طلای خود را به صورت فیزیکی از گالری زمرد دریافت نمایید/);
  assert.match(await page.textContent('body'), /۱\/۵۰ گرم/); // ۲ گرم - ۰٫۵ رزرو
  await page.fill('#weight', '1.6');
  await page.click('#del-go');
  await page.waitForSelector('.err:has-text("بیشتر از موجودی قابل تحویل")');
  step('تحویل: وزن بیش از موجودی قابل تحویل رد می‌شود');
  await page.click('[data-type=masnoat]');
  await page.fill('#weight', '1.5');
  await page.fill('textarea', 'تست تحویل');
  await page.click('#del-go');
  await page.click('.sheet button.primary');
  await page.waitForSelector('.sheet:has-text("شماره پیگیری")');
  assert.match(await page.textContent('.sheet'), /GZ-|[۰-۹]/);
  await shot('5-tracking');
  await page.click('.sheet button.primary');
  await page.waitForSelector('.item');
  const delOrders = (await j('GET', '/api/admin/orders?type=delivery', null, admin)).body.orders;
  assert.equal(delOrders.length, 1);
  assert.equal(delOrders[0].deliveryType, 'masnoat');
  step('درخواست تحویل با شماره پیگیری ثبت شد');

  // --- سوابق، فیلتر و لغو ---
  assert.equal(await page.locator('.item').count(), 3);
  await page.click('.chip:has-text("فروش")');
  assert.equal(await page.locator('.item').count(), 1);
  await page.click('.item');
  await page.click('button.danger');
  await page.click('.sheet button.primary');
  await page.waitForSelector('.item .tag:has-text("لغو شده")');
  await shot('6-history');
  step('سوابق: فیلتر و لغو درخواست در انتظار');

  // --- پروفایل و خروج ---
  await page.goto(base + '/app/#/profile');
  await page.waitForSelector('#save-profile');
  await page.fill('input >> nth=0', 'علیرضا');
  await page.click('#save-profile');
  await page.waitForSelector('.toast:has-text("ذخیره شد")');
  assert.equal((await j('GET', '/api/admin/users', null, admin)).body.users[0].firstName, 'علیرضا');
  await page.click('#logout');
  await page.waitForSelector('#send-otp');
  assert.equal(await page.evaluate(() => localStorage.getItem('gz_token')), null);
  step('پروفایل ویرایش شد و خروج انجام شد');

  assert.deepEqual(errors, [], 'خطای کنسول مرورگر: ' + errors.join(' | '));
  step('بدون خطای کنسول مرورگر');
  await browser.close();
  await app.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
