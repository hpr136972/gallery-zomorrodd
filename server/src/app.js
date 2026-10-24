'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { openDb, tx } = require('./db');
const U = require('./util');
const { HttpError } = U;

const MIN_BUY_SOT = 30;
const DELIVERY_TYPES = ['parsian', 'abshodeh', 'masnoat'];
const OTP_TTL_MS = 120_000;
const SESSION_TTL_MS = 30 * 24 * 3600_000;
const ADMIN_SESSION_TTL_MS = 12 * 3600_000;

function createApp(config, { sms } = {}) {
  const db = openDb(config.dbFile);
  const q = (sql) => db.prepare(sql);

  // ---------- مدیر اولیه ----------
  (function bootstrapAdmin() {
    const exists = q('SELECT 1 FROM admins LIMIT 1').get();
    if (exists) return;
    let pw = config.adminPassword;
    if (!pw) {
      if (config.production) throw new Error('در production باید ADMIN_PASSWORD برای ساخت مدیر اولیه تنظیم شود.');
      pw = crypto.randomBytes(9).toString('base64url');
      console.log(`[dev] مدیر اولیه ساخته شد: ${config.adminUser} / ${pw}  (فقط یک‌بار نمایش داده می‌شود)`);
    }
    const { salt, hash } = U.hashPassword(pw);
    q('INSERT INTO admins(username,salt,pass_hash) VALUES (?,?,?)').run(config.adminUser, salt, hash);
  })();

  // ---------- محدودکننده نرخ (در حافظه) ----------
  const buckets = new Map();
  function limit(key, max, windowMs) {
    const t = U.now();
    let b = buckets.get(key);
    if (!b || b.reset < t) { b = { n: 0, reset: t + windowMs }; buckets.set(key, b); }
    b.n++;
    if (b.n > max) throw new HttpError(429, 'تعداد درخواست‌ها زیاد است. کمی بعد دوباره تلاش کنید.');
  }
  const sweep = setInterval(() => {
    const t = U.now();
    for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k);
    q('DELETE FROM sessions WHERE expires_at < ?').run(t);
    q('DELETE FROM otps WHERE expires_at < ?').run(t);
  }, 60_000);
  sweep.unref();

  // ---------- توابع دامنه ----------
  const latestPrice = () => q('SELECT * FROM prices ORDER BY id DESC LIMIT 1').get();

  function ledgerTotals(userId) {
    const r = q('SELECT COALESCE(SUM(delta_sot),0) sot, COALESCE(SUM(delta_cost),0) cost FROM ledger WHERE user_id=?').get(userId);
    return { sot: r.sot, cost: r.cost };
  }
  function reservedSot(userId) {
    return q(`SELECT COALESCE(SUM(weight_sot),0) w FROM orders
              WHERE user_id=? AND type IN ('sell','delivery') AND status='pending'`).get(userId).w;
  }
  function portfolio(userId) {
    const { sot, cost } = ledgerTotals(userId);
    const reserved = reservedSot(userId);
    const p = latestPrice();
    const value = p ? U.mulDiv(sot, p.sell, 100) : 0;
    return {
      balanceSot: sot, reservedSot: reserved, availableSot: sot - reserved,
      costBasisToman: cost, valueToman: value, pnlToman: p ? value - cost : 0,
      price: p ? priceDto(p) : null,
    };
  }
  const priceDto = (p) => ({ buy: p.buy, sell: p.sell, source: p.source, isDemo: !!p.is_demo, updatedAt: p.created_at });

  const orderDto = (o) => ({
    id: o.id, type: o.type, method: o.method, weightSot: o.weight_sot, amountToman: o.amount_toman,
    pricePerGram: o.price_per_gram, status: o.status, deliveryType: o.delivery_type, tracking: o.tracking,
    details: o.details, isDemo: !!o.is_demo, createdAt: o.created_at, updatedAt: o.updated_at,
  });
  const userDto = (u) => ({
    id: u.id, phone: u.phone, code: u.code, firstName: u.first_name, lastName: u.last_name,
    fatherName: u.father_name, createdAt: u.created_at,
  });

  function newOrderId() { return 'O' + crypto.randomBytes(6).toString('hex').toUpperCase(); }

  function insertOrder(o) {
    const t = U.now();
    q(`INSERT INTO orders(id,user_id,type,method,weight_sot,amount_toman,price_per_gram,status,delivery_type,tracking,details,is_demo,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      o.id, o.userId, o.type, o.method ?? null, o.weightSot, o.amountToman ?? 0, o.pricePerGram ?? 0, o.status,
      o.deliveryType ?? null, o.tracking ?? null, o.details ?? '', config.demoMode ? 1 : 0, t, t);
    return q('SELECT * FROM orders WHERE id=?').get(o.id);
  }
  function setStatus(id, status, by, extra = {}) {
    q('UPDATE orders SET status=?, decided_by=?, updated_at=?, amount_toman=COALESCE(?,amount_toman), price_per_gram=COALESCE(?,price_per_gram), pay_ref=COALESCE(?,pay_ref) WHERE id=?')
      .run(status, by ?? null, U.now(), extra.amountToman ?? null, extra.pricePerGram ?? null, extra.payRef ?? null, id);
  }
  function audit(actor, action, target, meta) {
    q('INSERT INTO audit(actor,action,target,meta,at) VALUES (?,?,?,?,?)').run(actor, action, target ?? null, meta ? JSON.stringify(meta) : null, U.now());
  }

  /** افزایش موجودی بابت خرید تأییدشده. فقط یک‌بار برای هر سفارش (UNIQUE در دفتر کل). */
  function creditBuy(order) {
    try {
      q('INSERT INTO ledger(user_id,order_id,delta_sot,delta_cost,created_at) VALUES (?,?,?,?,?)')
        .run(order.user_id, order.id, order.weight_sot, order.amount_toman, U.now());
    } catch (e) {
      throw new HttpError(409, 'این سفارش قبلاً اعمال شده است.');
    }
  }
  /** کاهش موجودی بابت فروش/تحویل تأییدشده؛ بهای تمام‌شده به نسبت میانگین کم می‌شود. */
  function debit(order) {
    const { sot, cost } = ledgerTotals(order.user_id);
    if (sot < order.weight_sot) throw new HttpError(409, 'موجودی مشتری برای این درخواست کافی نیست.');
    const costDelta = order.weight_sot === sot ? cost : U.mulDivRound(cost, order.weight_sot, sot);
    try {
      q('INSERT INTO ledger(user_id,order_id,delta_sot,delta_cost,created_at) VALUES (?,?,?,?,?)')
        .run(order.user_id, order.id, -order.weight_sot, -costDelta, U.now());
    } catch (e) {
      throw new HttpError(409, 'این سفارش قبلاً اعمال شده است.');
    }
  }

  // ---------- احراز هویت ----------
  function newSession(kind, subjectId, ttl) {
    const token = crypto.randomBytes(32).toString('hex');
    q('INSERT INTO sessions(token_hash,kind,subject_id,expires_at) VALUES (?,?,?,?)').run(U.sha256(token), kind, subjectId, U.now() + ttl);
    return token;
  }
  function authenticate(req, kind) {
    const h = req.headers.authorization || '';
    const m = /^Bearer ([0-9a-f]{64})$/.exec(h);
    if (!m) throw new HttpError(401, 'ورود لازم است.');
    const s = q('SELECT * FROM sessions WHERE token_hash=? AND kind=? AND expires_at>?').get(U.sha256(m[1]), kind, U.now());
    if (!s) throw new HttpError(401, 'نشست نامعتبر یا منقضی شده است.');
    if (kind === 'user') {
      const u = q('SELECT * FROM users WHERE id=?').get(s.subject_id);
      if (!u) throw new HttpError(401, 'کاربر یافت نشد.');
      return u;
    }
    const a = q('SELECT * FROM admins WHERE id=?').get(s.subject_id);
    if (!a) throw new HttpError(401, 'مدیر یافت نشد.');
    return a;
  }

  function parseName(v, label) {
    const s = String(v ?? '').trim().replace(/\s+/g, ' ');
    if (s.length < 2 || s.length > 40) throw new HttpError(422, `${label} باید بین ۲ تا ۴۰ نویسه باشد.`);
    return s;
  }

  function allocateCode() {
    for (let i = 0; i < 200; i++) {
      const c = String(crypto.randomInt(1000, 10000));
      if (!q('SELECT 1 FROM users WHERE code=?').get(c)) return c;
    }
    throw new HttpError(503, 'ظرفیت کدهای چهاررقمی تکمیل شده است.');
  }

  /** پاسخ ثبت‌شده برای کلید یکتایی؛ از ثبت دوباره سفارش در تلاش مجدد/لمس مکرر جلوگیری می‌کند. */
  function withIdem(ctx, route, fn) {
    const key = ctx.req.headers['idempotency-key'];
    if (!key || key.length < 8 || key.length > 64) throw new HttpError(400, 'هدر Idempotency-Key (۸ تا ۶۴ نویسه) الزامی است.');
    return tx(db, () => {
      const prev = q('SELECT status,body FROM idem WHERE user_id=? AND key=? AND route=?').get(ctx.user.id, key, route);
      if (prev) return { status: prev.status, body: JSON.parse(prev.body) };
      const res = fn();
      q('INSERT INTO idem(user_id,key,route,status,body) VALUES (?,?,?,?,?)').run(ctx.user.id, key, route, res.status, JSON.stringify(res.body));
      return res;
    });
  }

  // ---------- مسیرها ----------
  const routes = [];
  const route = (method, p, auth, handler) =>
    routes.push({ method, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), auth, handler });
  const ok = (body, status = 200) => ({ status, body });

  route('GET', '/api/health', null, () => ok({ ok: true, demoMode: config.demoMode }));

  // --- ورود و ثبت‌نام با پیامک ---
  route('POST', '/api/auth/request-otp', null, async (ctx) => {
    const phone = U.normalizePhone(ctx.body.phone);
    limit('otp:' + phone, 1, 60_000);
    limit('otpip:' + ctx.ip, 20, 3600_000);
    if (config.smsMode === 'off') throw new HttpError(501, 'ارسال پیامک پیکربندی نشده است.');
    if (config.smsMode === 'provider' && !sms) throw new HttpError(501, 'آداپتور پیامک تنظیم نشده است.');
    const code = String(crypto.randomInt(100000, 1000000));
    q(`INSERT INTO otps(phone,code_hash,expires_at,attempts) VALUES (?,?,?,0)
       ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0`)
      .run(phone, U.sha256(code + phone + config.pepper), U.now() + OTP_TTL_MS);
    if (config.smsMode === 'provider') {
      await sms.send(phone, `کد ورود گالری زمرد: ${code}`);
      return ok({ ok: true, expiresInSec: OTP_TTL_MS / 1000 });
    }
    // حالت dev: پیامکی ارسال نمی‌شود؛ کد فقط برای توسعه برگردانده می‌شود.
    return ok({ ok: true, expiresInSec: OTP_TTL_MS / 1000, devCode: code, devNote: 'حالت آزمایشی: پیامک واقعی ارسال نشد.' });
  });

  route('POST', '/api/auth/verify', null, (ctx) => {
    const phone = U.normalizePhone(ctx.body.phone);
    limit('verifyip:' + ctx.ip, 60, 3600_000);
    const code = U.toEnDigits(ctx.body.code).trim();
    return tx(db, () => {
      const row = q('SELECT * FROM otps WHERE phone=?').get(phone);
      if (!row || row.expires_at < U.now()) throw new HttpError(400, 'کد منقضی شده یا درخواست نشده است.');
      if (row.attempts >= 5) { q('DELETE FROM otps WHERE phone=?').run(phone); throw new HttpError(429, 'تعداد تلاش بیش از حد مجاز است. کد جدید بگیرید.'); }
      q('UPDATE otps SET attempts=attempts+1 WHERE phone=?').run(phone);
      if (!/^\d{6}$/.test(code) || !U.safeEqual(U.sha256(code + phone + config.pepper), row.code_hash)) {
        db.exec('COMMIT'); db.exec('BEGIN IMMEDIATE'); // ثبت شمارنده تلاش حتی هنگام خطا
        throw new HttpError(400, 'کد واردشده صحیح نیست.');
      }
      let user = q('SELECT * FROM users WHERE phone=?').get(phone);
      let created = false;
      if (!user) {
        const first = parseName(ctx.body.firstName, 'نام');
        const last = parseName(ctx.body.lastName, 'نام خانوادگی');
        const father = parseName(ctx.body.fatherName, 'نام پدر');
        q('INSERT INTO users(phone,code,first_name,last_name,father_name,created_at) VALUES (?,?,?,?,?,?)')
          .run(phone, allocateCode(), first, last, father, U.now());
        user = q('SELECT * FROM users WHERE phone=?').get(phone);
        created = true;
      }
      q('DELETE FROM otps WHERE phone=?').run(phone);
      const token = newSession('user', user.id, SESSION_TTL_MS);
      return ok({ token, created, user: userDto(user) });
    });
  });

  route('POST', '/api/auth/logout', 'user', (ctx) => {
    const m = /^Bearer ([0-9a-f]{64})$/.exec(ctx.req.headers.authorization);
    q('DELETE FROM sessions WHERE token_hash=?').run(U.sha256(m[1]));
    return ok({ ok: true });
  });

  // --- پروفایل ---
  route('GET', '/api/me', 'user', (ctx) => ok({ user: userDto(ctx.user) }));
  route('PATCH', '/api/me', 'user', (ctx) => {
    const first = parseName(ctx.body.firstName, 'نام');
    const last = parseName(ctx.body.lastName, 'نام خانوادگی');
    const father = parseName(ctx.body.fatherName, 'نام پدر');
    q('UPDATE users SET first_name=?,last_name=?,father_name=? WHERE id=?').run(first, last, father, ctx.user.id);
    return ok({ user: userDto(q('SELECT * FROM users WHERE id=?').get(ctx.user.id)) });
  });

  route('GET', '/api/prices', 'user', () => {
    const p = latestPrice();
    return ok({ price: p ? priceDto(p) : null });
  });
  route('GET', '/api/portfolio', 'user', (ctx) => ok(portfolio(ctx.user.id)));

  // --- خرید ---
  route('POST', '/api/orders/buy', 'user', (ctx) => withIdem(ctx, 'buy', () => {
    const amount = ctx.body.amountToman;
    const method = ctx.body.method;
    if (!U.isPosInt(amount, 1e12)) throw new HttpError(422, 'مبلغ نامعتبر است.');
    if (!['online', 'card'].includes(method)) throw new HttpError(422, 'روش پرداخت نامعتبر است.');
    const p = latestPrice();
    if (!p) throw new HttpError(503, 'قیمت هنوز تعیین نشده است.');
    if (config.priceMaxAgeMin > 0 && U.now() - p.created_at > config.priceMaxAgeMin * 60_000) {
      throw new HttpError(503, 'قیمت منقضی شده است؛ لطفاً بعداً تلاش کنید.');
    }
    const weight = U.mulDiv(amount, 100, p.buy);
    if (weight < MIN_BUY_SOT) throw new HttpError(422, `حداقل خرید ${MIN_BUY_SOT} سوت است.`);
    const order = insertOrder({
      id: newOrderId(), userId: ctx.user.id, type: 'buy', method, weightSot: weight, amountToman: amount,
      pricePerGram: p.buy, status: method === 'card' ? 'pending_admin' : 'pending_payment',
      details: method === 'card' ? 'کارت‌به‌کارت: پس از تأیید مدیر نهایی می‌شود.' : 'پرداخت آنلاین: پس از تأیید درگاه نهایی می‌شود.',
    });
    return ok({ order: orderDto(order) }, 201);
  }));

  // تأیید پرداخت آنلاین (فراخوانی سرور-به-سرور درگاه؛ امضای HMAC الزامی است)
  route('POST', '/api/payments/verify', null, (ctx) => {
    if (!config.gatewaySecret) throw new HttpError(501, 'درگاه پرداخت پیکربندی نشده است.');
    limit('payip:' + ctx.ip, 120, 60_000);
    const { orderId, ref, amount, signature } = ctx.body;
    if (typeof orderId !== 'string' || typeof ref !== 'string' || !U.isPosInt(amount) || typeof signature !== 'string' || ref.length > 100) {
      throw new HttpError(400, 'درخواست نامعتبر است.');
    }
    if (!U.safeEqual(U.hmac(config.gatewaySecret, `${orderId}|${ref}|${amount}`), signature)) {
      throw new HttpError(403, 'امضا نامعتبر است.');
    }
    return tx(db, () => {
      const o = q('SELECT * FROM orders WHERE id=?').get(orderId);
      if (!o || o.type !== 'buy' || o.method !== 'online') throw new HttpError(404, 'سفارش یافت نشد.');
      if (o.status === 'completed') {
        if (o.pay_ref === ref) return ok({ ok: true, order: orderDto(o), replay: true });
        throw new HttpError(409, 'این سفارش با مرجع دیگری پرداخت شده است.');
      }
      if (o.status !== 'pending_payment') throw new HttpError(409, 'وضعیت سفارش اجازه تأیید پرداخت نمی‌دهد.');
      if (o.amount_toman !== amount) throw new HttpError(409, 'مبلغ پرداخت با سفارش مطابقت ندارد.');
      if (q('SELECT 1 FROM orders WHERE pay_ref=?').get(ref)) throw new HttpError(409, 'مرجع پرداخت تکراری است.');
      creditBuy(o);
      setStatus(o.id, 'completed', 'gateway', { payRef: ref });
      audit('gateway', 'payment_verified', o.id, { ref, amount });
      return ok({ ok: true, order: orderDto(q('SELECT * FROM orders WHERE id=?').get(o.id)) });
    });
  });

  // --- فروش ---
  route('POST', '/api/orders/sell', 'user', (ctx) => withIdem(ctx, 'sell', () => {
    const w = ctx.body.weightSot;
    if (!U.isPosInt(w, 1e10)) throw new HttpError(422, 'وزن نامعتبر است.');
    const p = latestPrice();
    if (!p) throw new HttpError(503, 'قیمت هنوز تعیین نشده است.');
    const pf = portfolio(ctx.user.id);
    if (w > pf.availableSot) throw new HttpError(422, 'وزن بیشتر از موجودی قابل فروش است.');
    const order = insertOrder({
      id: newOrderId(), userId: ctx.user.id, type: 'sell', weightSot: w, amountToman: U.mulDiv(w, p.sell, 100),
      pricePerGram: p.sell, status: 'pending', details: 'مبلغ تقریبی؛ مبلغ نهایی هنگام تأیید مدیر مشخص می‌شود.',
    });
    return ok({ order: orderDto(order) }, 201);
  }));

  // --- تحویل فیزیکی ---
  route('POST', '/api/orders/delivery', 'user', (ctx) => withIdem(ctx, 'delivery', () => {
    const w = ctx.body.weightSot;
    const type = ctx.body.deliveryType;
    const notes = String(ctx.body.notes ?? '').trim().slice(0, 500);
    if (!U.isPosInt(w, 1e10)) throw new HttpError(422, 'وزن نامعتبر است.');
    if (!DELIVERY_TYPES.includes(type)) throw new HttpError(422, 'نوع طلا نامعتبر است.');
    if (w > portfolio(ctx.user.id).availableSot) throw new HttpError(422, 'وزن بیشتر از موجودی قابل تحویل است.');
    const id = newOrderId();
    const order = insertOrder({
      id, userId: ctx.user.id, type: 'delivery', weightSot: w, deliveryType: type,
      tracking: 'GZ-' + id.slice(1), status: 'pending', details: notes,
    });
    return ok({ order: orderDto(order) }, 201);
  }));

  // --- سوابق ---
  route('GET', '/api/orders', 'user', (ctx) => {
    const t = ctx.query.get('type');
    const rows = t && ['buy', 'sell', 'delivery'].includes(t)
      ? q('SELECT * FROM orders WHERE user_id=? AND type=? ORDER BY created_at DESC, rowid DESC LIMIT 200').all(ctx.user.id, t)
      : q('SELECT * FROM orders WHERE user_id=? ORDER BY created_at DESC, rowid DESC LIMIT 200').all(ctx.user.id);
    return ok({ orders: rows.map(orderDto) });
  });
  route('GET', '/api/orders/:id', 'user', (ctx) => {
    const o = q('SELECT * FROM orders WHERE id=? AND user_id=?').get(ctx.params.id, ctx.user.id);
    if (!o) throw new HttpError(404, 'یافت نشد.');
    return ok({ order: orderDto(o) });
  });
  route('POST', '/api/orders/:id/cancel', 'user', (ctx) => tx(db, () => {
    const o = q('SELECT * FROM orders WHERE id=? AND user_id=?').get(ctx.params.id, ctx.user.id);
    if (!o) throw new HttpError(404, 'یافت نشد.');
    if (!['pending', 'pending_admin', 'pending_payment'].includes(o.status)) throw new HttpError(409, 'این سفارش دیگر قابل لغو نیست.');
    setStatus(o.id, 'cancelled', 'user');
    return ok({ order: orderDto(q('SELECT * FROM orders WHERE id=?').get(o.id)) });
  }));

  // ---------- مدیریت ----------
  route('POST', '/api/admin/login', null, (ctx) => {
    limit('adminlogin:' + ctx.ip, 10, 15 * 60_000);
    const a = q('SELECT * FROM admins WHERE username=?').get(String(ctx.body.username ?? ''));
    const pw = String(ctx.body.password ?? '');
    // محاسبه هش حتی برای کاربر ناموجود تا زمان پاسخ یکسان بماند
    const fake = a || { salt: '00', pass_hash: '0'.repeat(128) };
    const good = U.verifyPassword(pw, fake.salt, fake.pass_hash);
    if (!a || !good) throw new HttpError(401, 'نام کاربری یا رمز عبور نادرست است.');
    audit(a.username, 'admin_login', null);
    return ok({ token: newSession('admin', a.id, ADMIN_SESSION_TTL_MS) });
  });

  route('GET', '/api/admin/users', 'admin', () => {
    const rows = q(`SELECT u.*, COALESCE((SELECT SUM(delta_sot) FROM ledger WHERE user_id=u.id),0) bal FROM users u ORDER BY u.id DESC LIMIT 500`).all();
    return ok({ users: rows.map((u) => ({ ...userDto(u), balanceSot: u.bal })) });
  });

  route('GET', '/api/admin/orders', 'admin', (ctx) => {
    const where = []; const args = [];
    for (const [k, col, allowed] of [
      ['status', 'o.status', null], ['type', 'o.type', ['buy', 'sell', 'delivery']], ['method', 'o.method', ['online', 'card']],
    ]) {
      const v = ctx.query.get(k);
      if (v && (!allowed || allowed.includes(v))) { where.push(`${col}=?`); args.push(v); }
    }
    const rows = q(`SELECT o.*, u.first_name, u.last_name, u.code, u.phone FROM orders o JOIN users u ON u.id=o.user_id
                    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.created_at DESC, o.rowid DESC LIMIT 300`).all(...args);
    return ok({
      orders: rows.map((o) => ({ ...orderDto(o), customer: { name: `${o.first_name} ${o.last_name}`, code: o.code, phone: o.phone } })),
    });
  });

  route('POST', '/api/admin/prices', 'admin', (ctx) => {
    const { buy, sell } = ctx.body;
    if (!U.isPosInt(buy, 1e10) || !U.isPosInt(sell, 1e10)) throw new HttpError(422, 'قیمت‌ها باید عدد صحیح مثبت باشند.');
    if (sell > buy) throw new HttpError(422, 'قیمت فروش نباید از قیمت خرید بیشتر باشد.');
    q('INSERT INTO prices(buy,sell,source,is_demo,created_by,created_at) VALUES (?,?,?,?,?,?)')
      .run(buy, sell, 'manual', config.demoMode ? 1 : 0, ctx.admin.username, U.now());
    audit(ctx.admin.username, 'set_prices', null, { buy, sell });
    return ok({ price: priceDto(latestPrice()) });
  });

  // تغییر وضعیت سفارش توسط مدیر: approve | reject | complete
  route('POST', '/api/admin/orders/:id/:action', 'admin', (ctx) => tx(db, () => {
    const { id, action } = ctx.params;
    const by = ctx.admin.username;
    const o = q('SELECT * FROM orders WHERE id=?').get(id);
    if (!o) throw new HttpError(404, 'سفارش یافت نشد.');
    const bad = () => new HttpError(409, `انجام «${action}» برای وضعیت فعلی (${o.status}) مجاز نیست.`);

    if (action === 'reject') {
      if (!['pending', 'pending_admin', 'pending_payment'].includes(o.status)) throw bad();
      setStatus(id, 'rejected', by);
    } else if (action === 'approve') {
      if (o.type === 'buy') {
        // فقط کارت‌به‌کارت توسط مدیر تأیید می‌شود؛ پرداخت آنلاین فقط با تأیید درگاه.
        if (o.method !== 'card' || o.status !== 'pending_admin') throw bad();
        creditBuy(o);
        setStatus(id, 'completed', by);
      } else {
        if (o.status !== 'pending') throw bad();
        if (o.type === 'sell') {
          const p = latestPrice();
          if (!p) throw new HttpError(503, 'قیمت تعیین نشده است.');
          debit(o);
          setStatus(id, 'approved', by, { pricePerGram: p.sell, amountToman: U.mulDiv(o.weight_sot, p.sell, 100) });
        } else {
          debit(o);
          setStatus(id, 'approved', by);
        }
      }
    } else if (action === 'complete') {
      // تسویه فروش یا تحویل فیزیکی پس از انجام واقعی کار
      if (!['sell', 'delivery'].includes(o.type) || o.status !== 'approved') throw bad();
      setStatus(id, 'completed', by);
    } else {
      throw new HttpError(404, 'عملیات نامعتبر است.');
    }
    audit(by, `order_${action}`, id);
    return ok({ order: orderDto(q('SELECT * FROM orders WHERE id=?').get(id)) });
  }));

  route('GET', '/api/admin/audit', 'admin', () =>
    ok({ audit: q('SELECT * FROM audit ORDER BY id DESC LIMIT 200').all() }));

  // ---------- فایل‌های ایستای پنل مدیریت و وب‌اپ مشتری ----------
  const pubDir = path.join(__dirname, '..', 'public');
  const STATIC = {
    '/admin': 'admin/index.html', '/admin/': 'admin/index.html', '/admin/app.js': 'admin/app.js', '/admin/style.css': 'admin/style.css',
    '/app': 'app/index.html', '/app/': 'app/index.html', '/app/app.js': 'app/app.js', '/app/style.css': 'app/style.css',
    '/app/manifest.webmanifest': 'app/manifest.webmanifest', '/app/icon.svg': 'app/icon.svg',
  };
  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json; charset=utf-8',
  };

  const SEC = {
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  };

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { ...SEC, ...headers });
    res.end(body);
  }

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 100_000) throw new HttpError(413, 'حجم درخواست زیاد است.');
      chunks.push(c);
    }
    if (!size) return {};
    try {
      const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error();
      return v;
    } catch { throw new HttpError(400, 'بدنه درخواست JSON معتبر نیست.'); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 302, '', { Location: '/app/' });
      }
      const file = STATIC[url.pathname];
      if (req.method === 'GET' && file) {
        const data = fs.readFileSync(path.join(pubDir, file));
        return send(res, 200, data, { 'Content-Type': MIME[path.extname(file)] });
      }
      const pathname = url.pathname.replace(/\/+$/, '') || '/';
      let matched = null; let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method === req.method) { matched = { r, params: m.groups || {} }; break; }
      }
      if (!matched) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'روش درخواست مجاز نیست.' : 'یافت نشد.');
      const ip = config.trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress : req.socket.remoteAddress;
      const ctx = { req, ip, params: matched.params, query: url.searchParams, body: {} };
      if (matched.r.auth === 'user') ctx.user = authenticate(req, 'user');
      if (matched.r.auth === 'admin') ctx.admin = authenticate(req, 'admin');
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) ctx.body = await readBody(req);
      const out = await matched.r.handler(ctx);
      send(res, out.status, JSON.stringify(out.body), { 'Content-Type': 'application/json; charset=utf-8' });
    } catch (e) {
      if (e instanceof HttpError) {
        return send(res, e.status, JSON.stringify({ error: e.message, ...(e.extra || {}) }), { 'Content-Type': 'application/json; charset=utf-8' });
      }
      console.error('[error]', e && e.message);
      send(res, 500, JSON.stringify({ error: 'خطای داخلی سرور.' }), { 'Content-Type': 'application/json; charset=utf-8' });
    }
  });

  return {
    server, db,
    listen: (port = config.port, host = '0.0.0.0') => new Promise((r) => server.listen(port, host, () => r(server.address().port))),
    close: () => new Promise((r) => { clearInterval(sweep); server.close(() => { db.close(); r(); }); }),
  };
}

module.exports = { createApp };
