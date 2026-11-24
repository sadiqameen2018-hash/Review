import crypto from 'node:crypto';

const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/i;

export function isValidShop(shop) {
  return typeof shop === 'string' && SHOP_RE.test(shop);
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** OAuth / admin-load query HMAC: params sorted, joined with '&', hex digest. */
export function verifyQueryHmac(query, secret) {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? JSON.stringify(rest[k]) : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return safeEqual(digest, hmac);
}

/** App proxy signature: params sorted, arrays joined by ',', concatenated with no separator. */
export function verifyProxySignature(query, secret) {
  const { signature, ...rest } = query;
  if (!signature) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  return safeEqual(digest, signature);
}

/** Webhook HMAC: base64 digest of the raw body. */
export function verifyWebhookHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader) return false;
  const digest = crypto.createHmac('sha256', secret).update(rawBody).digest('base64');
  return safeEqual(digest, hmacHeader);
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');

/** Verify an App Bridge session token (HS256 JWT). Returns { shop, payload } or throws. */
export function verifySessionToken(token, { apiKey, apiSecret }, now = Date.now()) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [h, p, s] = parts;
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'HS256') throw new Error('Unsupported alg');
  const expected = b64url(crypto.createHmac('sha256', apiSecret).update(`${h}.${p}`).digest());
  if (!safeEqual(expected, s)) throw new Error('Bad signature');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  const nowSec = Math.floor(now / 1000);
  const leeway = 5;
  if (payload.exp && nowSec > payload.exp + leeway) throw new Error('Token expired');
  if (payload.nbf && nowSec < payload.nbf - leeway) throw new Error('Token not yet valid');
  if (payload.aud !== apiKey) throw new Error('Wrong audience');
  const shop = new URL(payload.dest).hostname;
  if (!isValidShop(shop)) throw new Error('Bad shop');
  return { shop, payload };
}

/** Helper for tests and tooling. */
export function signSessionToken(payload, secret) {
  const h = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64url(JSON.stringify(payload));
  const s = b64url(crypto.createHmac('sha256', secret).update(`${h}.${p}`).digest());
  return `${h}.${p}.${s}`;
}

export async function exchangeCodeForToken({ shop, code, apiKey, apiSecret, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://${shop}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: apiKey, client_secret: apiSecret, code }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`);
  return res.json(); // { access_token, scope }
}

export async function adminGraphql({ shop, accessToken, apiVersion, query, variables, fetchImpl = fetch }) {
  const res = await fetchImpl(`https://${shop}/admin/api/${apiVersion}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': accessToken },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Admin API ${res.status}`);
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const METAFIELDS_SET = `mutation SetRating($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) { userErrors { field message } }
}`;

/** Writes the standard reviews.rating / reviews.rating_count product metafields (used by themes & Google). */
export async function syncProductRating({ shop, accessToken, apiVersion, productId, summary, fetchImpl }) {
  const ownerId = `gid://shopify/Product/${productId}`;
  const metafields = [
    {
      ownerId, namespace: 'reviews', key: 'rating', type: 'rating',
      value: JSON.stringify({ value: summary.average.toFixed(1), scale_min: '1.0', scale_max: '5.0' }),
    },
    { ownerId, namespace: 'reviews', key: 'rating_count', type: 'number_integer', value: String(summary.count) },
  ];
  if (summary.count === 0) metafields.shift(); // rating must be within scale; skip when no reviews
  const data = await adminGraphql({
    shop, accessToken, apiVersion, query: METAFIELDS_SET, variables: { metafields }, fetchImpl,
  });
  const errors = data.metafieldsSet.userErrors;
  if (errors.length) throw new Error(JSON.stringify(errors));
}
