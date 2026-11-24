import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import {
  isValidShop, verifyQueryHmac, verifyProxySignature, verifyWebhookHmac,
  verifySessionToken, exchangeCodeForToken, syncProductRating,
} from './shopify.js';
import { STATUSES } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = fs.readFileSync(path.join(here, '..', 'web', 'admin.html'), 'utf8');

const publicReview = (r) => ({
  id: r.id, author: r.author, rating: r.rating, title: r.title, body: r.body, created_at: r.created_at,
});

const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

export function validateReview(input) {
  const errors = {};
  const author = clean(input.author, 80);
  const email = clean(input.email, 200);
  const title = clean(input.title, 150);
  const body = clean(input.body, 5000);
  const rating = Number(input.rating);
  const productId = String(input.product_id ?? '').trim();
  if (!/^\d+$/.test(productId)) errors.product_id = 'Invalid product';
  if (!author) errors.author = 'Name is required';
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'Invalid email';
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) errors.rating = 'Rating must be 1-5';
  if (body.length < 3) errors.body = 'Review is too short';
  return { errors, value: { author, email: email || null, title: title || null, body, rating, productId } };
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').filter(Boolean).map((c) => {
    const i = c.indexOf('=');
    return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }));
}

export function createApp({ config, db, fetchImpl = fetch, logger = console }) {
  const app = express();
  app.set('trust proxy', true);

  // Best-effort sync of rating metafields so themes/Google can show stars without JS.
  async function syncRating(shop, productId) {
    const row = db.getShop(shop);
    if (!row?.access_token) return;
    try {
      await syncProductRating({
        shop, accessToken: row.access_token, apiVersion: config.apiVersion,
        productId, summary: db.summary(shop, productId), fetchImpl,
      });
    } catch (err) {
      logger.warn(`[metafields] ${shop} product ${productId}: ${err.message}`);
    }
  }

  /* ---------------- Webhooks (raw body needed for HMAC) ---------------- */
  app.post('/webhooks', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
    const ok = verifyWebhookHmac(req.body, req.get('X-Shopify-Hmac-Sha256'), config.apiSecret);
    if (!ok) return res.sendStatus(401);
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');
    let payload = {};
    try { payload = JSON.parse(req.body.toString('utf8') || '{}'); } catch { /* ignore */ }

    switch (topic) {
      case 'app/uninstalled':
        db.deleteShopToken(shop);
        break;
      case 'shop/redact':
        db.redactShop(shop);
        break;
      case 'customers/redact':
        db.redactCustomer(shop, payload.customer?.id, payload.customer?.email);
        break;
      case 'customers/data_request': {
        const rows = db.customerReviews(shop, payload.customer?.id, payload.customer?.email);
        logger.info(`[gdpr] data request for ${shop}: ${rows.length} review(s) on file`);
        break;
      }
      default:
        logger.info(`[webhook] unhandled topic ${topic}`);
    }
    res.sendStatus(200);
  });

  app.use(express.json({ limit: '100kb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));

  /* ---------------- OAuth ---------------- */
  app.get('/auth', (req, res) => {
    const { shop } = req.query;
    if (!isValidShop(shop)) return res.status(400).send('Invalid shop');
    const state = crypto.randomBytes(16).toString('hex');
    res.setHeader('Set-Cookie',
      `shopify_oauth_state=${state}; Path=/auth; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
    const url = new URL(`https://${shop}/admin/oauth/authorize`);
    url.searchParams.set('client_id', config.apiKey);
    url.searchParams.set('scope', config.scopes);
    url.searchParams.set('redirect_uri', `${config.appUrl}/auth/callback`);
    url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  app.get('/auth/callback', async (req, res) => {
    const { shop, code, state } = req.query;
    const cookieState = parseCookies(req.get('cookie')).shopify_oauth_state;
    if (!isValidShop(shop) || !code) return res.status(400).send('Invalid request');
    if (!verifyQueryHmac(req.query, config.apiSecret)) return res.status(401).send('HMAC validation failed');
    if (!state || state !== cookieState) return res.status(403).send('State mismatch');
    try {
      const { access_token, scope } = await exchangeCodeForToken({
        shop, code, apiKey: config.apiKey, apiSecret: config.apiSecret, fetchImpl,
      });
      db.saveShop(shop, access_token, scope);
      res.redirect(`https://${shop}/admin/apps/${config.apiKey}`);
    } catch (err) {
      logger.error(err);
      res.status(500).send('Could not complete installation');
    }
  });

  /* ---------------- Embedded admin page ---------------- */
  app.get('/', (req, res) => {
    const { shop } = req.query;
    if (isValidShop(shop)) {
      if (req.query.hmac && !verifyQueryHmac(req.query, config.apiSecret)) {
        return res.status(401).send('HMAC validation failed');
      }
      if (!db.getShop(shop)?.access_token) {
        return res.redirect(`/auth?shop=${encodeURIComponent(shop)}`);
      }
      res.setHeader('Content-Security-Policy',
        `frame-ancestors https://${shop} https://admin.shopify.com;`);
    }
    res.type('html').send(ADMIN_HTML.replace('%SHOPIFY_API_KEY%', config.apiKey));
  });

  /* ---------------- Admin API (App Bridge session token) ---------------- */
  const api = express.Router();
  api.use((req, res, next) => {
    const token = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    try {
      req.shop = verifySessionToken(token, config).shop;
      next();
    } catch (err) {
      res.status(401).json({ error: err.message });
    }
  });

  api.get('/reviews', (req, res) => {
    const status = STATUSES.includes(req.query.status) ? req.query.status : undefined;
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    res.json(db.listReviews(req.shop, { status, productId: req.query.product_id, limit, offset }));
  });

  api.patch('/reviews/:id', async (req, res) => {
    const { status } = req.body || {};
    if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Invalid status' });
    const review = db.getReview(req.shop, Number(req.params.id));
    if (!review) return res.status(404).json({ error: 'Not found' });
    db.setStatus(req.shop, review.id, status);
    await syncRating(req.shop, review.product_id);
    res.json(db.getReview(req.shop, review.id));
  });

  api.delete('/reviews/:id', async (req, res) => {
    const review = db.getReview(req.shop, Number(req.params.id));
    if (!review) return res.status(404).json({ error: 'Not found' });
    db.deleteReview(req.shop, review.id);
    await syncRating(req.shop, review.product_id);
    res.sendStatus(204);
  });

  api.get('/settings', (req, res) => {
    res.json({ auto_publish: Boolean(db.getShop(req.shop)?.auto_publish) });
  });

  api.put('/settings', (req, res) => {
    db.setAutoPublish(req.shop, Boolean(req.body?.auto_publish));
    res.json({ auto_publish: Boolean(db.getShop(req.shop)?.auto_publish) });
  });

  app.use('/api', api);

  /* ---------------- Storefront app proxy (/apps/reviews/* -> /proxy/*) ---------------- */
  const proxy = express.Router();
  proxy.use((req, res, next) => {
    if (!verifyProxySignature(req.query, config.apiSecret)) return res.status(401).json({ error: 'Bad signature' });
    const shop = req.query.shop;
    if (!isValidShop(shop) || !db.getShop(shop)) return res.status(404).json({ error: 'Unknown shop' });
    req.shop = shop;
    next();
  });

  proxy.get('/reviews', (req, res) => {
    const productId = String(req.query.product_id || '');
    if (!/^\d+$/.test(productId)) return res.status(400).json({ error: 'product_id required' });
    const perPage = Math.min(Number(req.query.per_page) || 10, 50);
    const page = Math.max(Number(req.query.page) || 1, 1);
    const { total, rows } = db.listReviews(req.shop, {
      status: 'approved', productId, limit: perPage, offset: (page - 1) * perPage,
    });
    res.set('Cache-Control', 'public, max-age=60');
    res.json({
      summary: db.summary(req.shop, productId),
      reviews: rows.map(publicReview),
      page, per_page: perPage, total,
    });
  });

  const recent = new Map(); // simple in-memory rate limit: 5 submissions / 10 min per shop+ip
  proxy.post('/reviews', async (req, res) => {
    const body = req.body || {};
    if (body.website) return res.status(201).json({ status: 'pending' }); // honeypot: silently drop bots

    const key = `${req.shop}|${req.ip}`;
    const now = Date.now();
    const hits = (recent.get(key) || []).filter((t) => now - t < 10 * 60 * 1000);
    if (hits.length >= 5) return res.status(429).json({ error: 'Too many reviews, please try later' });

    const { errors, value } = validateReview(body);
    if (Object.keys(errors).length) return res.status(422).json({ errors });

    hits.push(now);
    recent.set(key, hits);

    const autoPublish = Boolean(db.getShop(req.shop)?.auto_publish);
    const review = db.createReview({
      ...value,
      shop: req.shop,
      customerId: req.query.logged_in_customer_id || null,
      status: autoPublish ? 'approved' : 'pending',
    });
    if (autoPublish) await syncRating(req.shop, value.productId);
    res.status(201).json({ status: review.status, review: autoPublish ? publicReview(review) : undefined });
  });

  app.use('/proxy', proxy);

  app.get('/health', (req, res) => res.json({ ok: true }));
  return app;
}
