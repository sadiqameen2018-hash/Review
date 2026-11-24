import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { openDb } from '../server/db.js';
import { createApp, validateReview } from '../server/app.js';
import { signSessionToken, verifyProxySignature, verifyQueryHmac, verifySessionToken } from '../server/shopify.js';

const config = {
  apiKey: 'key123', apiSecret: 'secret456', appUrl: 'https://app.test',
  scopes: 'write_products', apiVersion: '2026-10',
};
const SHOP = 'demo.myshopify.com';
const graphqlCalls = [];
const fetchImpl = async (url, opts) => {
  graphqlCalls.push({ url, body: JSON.parse(opts.body) });
  return new Response(JSON.stringify({ data: { metafieldsSet: { userErrors: [] } } }), { status: 200 });
};
const quiet = { info() {}, warn() {}, error() {} };

let server, base, db;
before(async () => {
  db = openDb(':memory:');
  db.saveShop(SHOP, 'shpat_x', 'write_products');
  server = createApp({ config, db, fetchImpl, logger: quiet }).listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function proxyQuery(extra = {}) {
  const params = { shop: SHOP, path_prefix: '/apps/reviews', timestamp: String(Math.floor(Date.now() / 1000)), ...extra };
  const msg = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('');
  params.signature = crypto.createHmac('sha256', config.apiSecret).update(msg).digest('hex');
  return new URLSearchParams(params).toString();
}
const token = () => signSessionToken({
  iss: `https://${SHOP}/admin`, dest: `https://${SHOP}`, aud: config.apiKey,
  exp: Math.floor(Date.now() / 1000) + 60, nbf: Math.floor(Date.now() / 1000) - 5,
}, config.apiSecret);
const adminFetch = (path, opts = {}) => fetch(base + path, {
  ...opts, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
});

test('signature helpers', () => {
  const q = { shop: SHOP, timestamp: '1' };
  const sig = crypto.createHmac('sha256', 'secret456').update(`shop=${SHOP}timestamp=1`).digest('hex');
  assert.ok(verifyProxySignature({ ...q, signature: sig }, 'secret456'));
  assert.ok(!verifyProxySignature({ ...q, signature: sig.replace(/.$/, '0') }, 'secret456'));
  const hmac = crypto.createHmac('sha256', 'secret456').update(`shop=${SHOP}&timestamp=1`).digest('hex');
  assert.ok(verifyQueryHmac({ ...q, hmac }, 'secret456'));
  assert.throws(() => verifySessionToken(token(), { ...config, apiKey: 'other' }), /audience/);
  assert.throws(() => verifySessionToken(token(), { ...config, apiSecret: 'nope' }), /signature/);
});

test('validateReview', () => {
  const bad = validateReview({ product_id: 'x', rating: 9, body: '' });
  assert.deepEqual(Object.keys(bad.errors).sort(), ['author', 'body', 'product_id', 'rating']);
  const ok = validateReview({ product_id: '1', rating: '5', author: ' Ali ', body: 'Great!' });
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.value.author, 'Ali');
});

test('proxy rejects unsigned requests', async () => {
  const res = await fetch(`${base}/proxy/reviews?shop=${SHOP}&product_id=1`);
  assert.equal(res.status, 401);
});

test('full review flow: submit → pending → approve → visible with summary', async () => {
  let res = await fetch(`${base}/proxy/reviews?${proxyQuery()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: '42', rating: 4, author: 'Sara', email: 's@x.com', title: 'Nice', body: 'Good quality' }),
  });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).status, 'pending');

  res = await fetch(`${base}/proxy/reviews?${proxyQuery({ product_id: '42' })}`);
  let data = await res.json();
  assert.equal(data.reviews.length, 0, 'pending review is hidden');

  res = await adminFetch('/api/reviews?status=pending');
  const { rows } = await res.json();
  assert.equal(rows.length, 1);

  res = await adminFetch(`/api/reviews/${rows[0].id}`, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) });
  assert.equal((await res.json()).status, 'approved');
  const call = graphqlCalls.at(-1);
  assert.match(call.url, /demo\.myshopify\.com\/admin\/api\/2026-10\/graphql\.json/);
  assert.equal(call.body.variables.metafields[1].value, '1');

  res = await fetch(`${base}/proxy/reviews?${proxyQuery({ product_id: '42' })}`);
  data = await res.json();
  assert.equal(data.reviews.length, 1);
  assert.equal(data.reviews[0].email, undefined, 'email never exposed publicly');
  assert.deepEqual(data.summary, { count: 1, average: 4, distribution: { 1: 0, 2: 0, 3: 0, 4: 1, 5: 0 } });
});

test('auto-publish setting', async () => {
  await adminFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ auto_publish: true }) });
  const res = await fetch(`${base}/proxy/reviews?${proxyQuery()}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ product_id: '7', rating: 5, author: 'Omar', body: 'Excellent' }),
  });
  assert.equal((await res.json()).status, 'approved');
});

test('admin API requires session token', async () => {
  const res = await fetch(`${base}/api/reviews`);
  assert.equal(res.status, 401);
});

test('webhooks: HMAC enforced, customers/redact deletes data', async () => {
  const body = JSON.stringify({ customer: { id: 1, email: 'S@X.com' } });
  const send = (hmac) => fetch(`${base}/webhooks`, {
    method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Shopify-Topic': 'customers/redact',
      'X-Shopify-Shop-Domain': SHOP, 'X-Shopify-Hmac-Sha256': hmac },
  });
  assert.equal((await send('bogus')).status, 401);
  const good = crypto.createHmac('sha256', config.apiSecret).update(body).digest('base64');
  assert.equal((await send(good)).status, 200);
  assert.equal(db.customerReviews(SHOP, null, 's@x.com').length, 0);
});
