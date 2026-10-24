'use strict';
const { DatabaseSync } = require('node:sqlite');

// وزن همیشه به «سوت» (۱ گرم = ۱۰۰ سوت) و مبلغ به «تومان» و به‌صورت عدد صحیح ذخیره می‌شود.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,
  code TEXT NOT NULL UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  father_name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otps (
  phone TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('user','admin')),
  subject_id INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  salt TEXT NOT NULL,
  pass_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  buy INTEGER NOT NULL CHECK (buy > 0),
  sell INTEGER NOT NULL CHECK (sell > 0 AND sell <= buy),
  source TEXT NOT NULL DEFAULT 'manual',
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK (type IN ('buy','sell','delivery')),
  method TEXT,
  weight_sot INTEGER NOT NULL CHECK (weight_sot > 0),
  amount_toman INTEGER NOT NULL DEFAULT 0,
  price_per_gram INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  delivery_type TEXT,
  tracking TEXT,
  details TEXT NOT NULL DEFAULT '',
  pay_ref TEXT,
  is_demo INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS orders_pay_ref ON orders(pay_ref) WHERE pay_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_user ON orders(user_id, created_at);
CREATE INDEX IF NOT EXISTS orders_status ON orders(status);
-- دفتر کل: تنها منبع موجودی. UNIQUE(order_id) تضمین می‌کند هر سفارش فقط یک‌بار موجودی را تغییر دهد.
CREATE TABLE IF NOT EXISTS ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  delta_sot INTEGER NOT NULL,
  delta_cost INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS idem (
  user_id INTEGER NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (user_id, key, route)
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target TEXT,
  meta TEXT,
  at INTEGER NOT NULL
);
`;

function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  return db;
}

/** اجرای اتمیک؛ هر خطا باعث بازگشت کامل تغییرات می‌شود. */
function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
    throw e;
  }
}

module.exports = { openDb, tx };
