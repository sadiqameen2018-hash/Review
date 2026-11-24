import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const STATUSES = ['pending', 'approved', 'rejected'];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS shops (
      shop TEXT PRIMARY KEY,
      access_token TEXT,
      scope TEXT,
      auto_publish INTEGER NOT NULL DEFAULT 0,
      installed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop TEXT NOT NULL,
      product_id TEXT NOT NULL,
      customer_id TEXT,
      author TEXT NOT NULL,
      email TEXT,
      rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
      title TEXT,
      body TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews (shop, product_id, status);
  `);
  return wrap(db);
}

function wrap(db) {
  const q = (sql) => db.prepare(sql);
  return {
    raw: db,
    getShop: (shop) => q('SELECT * FROM shops WHERE shop = ?').get(shop),
    saveShop: (shop, accessToken, scope) =>
      q(`INSERT INTO shops (shop, access_token, scope) VALUES (?, ?, ?)
         ON CONFLICT(shop) DO UPDATE SET access_token = excluded.access_token, scope = excluded.scope`)
        .run(shop, accessToken, scope),
    deleteShopToken: (shop) => q('UPDATE shops SET access_token = NULL WHERE shop = ?').run(shop),
    setAutoPublish: (shop, on) => q('UPDATE shops SET auto_publish = ? WHERE shop = ?').run(on ? 1 : 0, shop),
    redactShop: (shop) => {
      q('DELETE FROM reviews WHERE shop = ?').run(shop);
      q('DELETE FROM shops WHERE shop = ?').run(shop);
    },
    redactCustomer: (shop, customerId, email) =>
      q(`DELETE FROM reviews WHERE shop = ? AND ((customer_id IS NOT NULL AND customer_id = ?)
           OR (email IS NOT NULL AND lower(email) = lower(?)))`)
        .run(shop, customerId == null ? null : String(customerId), email ?? null),
    customerReviews: (shop, customerId, email) =>
      q(`SELECT * FROM reviews WHERE shop = ? AND ((customer_id IS NOT NULL AND customer_id = ?)
           OR (email IS NOT NULL AND lower(email) = lower(?)))`)
        .all(shop, customerId == null ? null : String(customerId), email ?? null),

    createReview: (r) => {
      const info = q(`INSERT INTO reviews (shop, product_id, customer_id, author, email, rating, title, body, status)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(r.shop, String(r.productId), r.customerId ?? null, r.author, r.email ?? null,
          r.rating, r.title ?? null, r.body, r.status);
      return q('SELECT * FROM reviews WHERE id = ?').get(Number(info.lastInsertRowid));
    },
    getReview: (shop, id) => q('SELECT * FROM reviews WHERE shop = ? AND id = ?').get(shop, id),
    setStatus: (shop, id, status) => q('UPDATE reviews SET status = ? WHERE shop = ? AND id = ?').run(status, shop, id),
    deleteReview: (shop, id) => q('DELETE FROM reviews WHERE shop = ? AND id = ?').run(shop, id),

    listReviews: (shop, { status, productId, limit = 50, offset = 0 } = {}) => {
      const where = ['shop = ?'];
      const args = [shop];
      if (status) { where.push('status = ?'); args.push(status); }
      if (productId) { where.push('product_id = ?'); args.push(String(productId)); }
      const w = where.join(' AND ');
      const total = q(`SELECT COUNT(*) AS n FROM reviews WHERE ${w}`).get(...args).n;
      const rows = q(`SELECT * FROM reviews WHERE ${w} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
        .all(...args, limit, offset);
      return { total, rows };
    },

    summary: (shop, productId) => {
      const rows = q(`SELECT rating, COUNT(*) AS n FROM reviews
                      WHERE shop = ? AND product_id = ? AND status = 'approved' GROUP BY rating`)
        .all(shop, String(productId));
      const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      let count = 0, sum = 0;
      for (const { rating, n } of rows) { distribution[rating] = n; count += n; sum += rating * n; }
      return { count, average: count ? Math.round((sum / count) * 10) / 10 : 0, distribution };
    },
  };
}
