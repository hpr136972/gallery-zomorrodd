'use strict';
const crypto = require('node:crypto');

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function toEnDigits(s) {
  return String(s ?? '')
    .replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660));
}

function normalizePhone(p) {
  const t = toEnDigits(p).replace(/\s+/g, '');
  if (!/^09\d{9}$/.test(t)) throw new HttpError(422, 'شماره موبایل باید ۱۱ رقم و با ۰۹ شروع شود.');
  return t;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const h = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash: h };
}
function verifyPassword(password, salt, hash) {
  return safeEqual(crypto.scryptSync(password, salt, 64).toString('hex'), hash);
}

/** floor(a*b/c) بدون سرریز اعداد بزرگ */
function mulDiv(a, b, c) {
  if (c === 0) return 0;
  return Number((BigInt(a) * BigInt(b)) / BigInt(c));
}
/** round-half-up(a*b/c) */
function mulDivRound(a, b, c) {
  if (c === 0) return 0;
  const n = BigInt(a) * BigInt(b) * 2n + BigInt(c);
  return Number(n / (2n * BigInt(c)));
}

const now = () => Date.now();

function isPosInt(v, max = Number.MAX_SAFE_INTEGER) {
  return Number.isSafeInteger(v) && v > 0 && v <= max;
}

module.exports = {
  HttpError, toEnDigits, normalizePhone, sha256, hmac, safeEqual,
  hashPassword, verifyPassword, mulDiv, mulDivRound, now, isPosInt,
};
