# Shopify Product Reviews App

A Shopify app that adds product reviews to a store:

- **Storefront review block**: average rating, 1–5★ breakdown, paginated reviews and a "Write a review" form (theme app extension, works with Online Store 2.0 themes).
- **Star rating block**: small ★★★★☆ badge for product pages, rendered from the standard `reviews.rating` / `reviews.rating_count` product metafields, so it needs no JavaScript and Google can read it.
- **Admin moderation page** inside Shopify admin: approve, reject or delete reviews, and turn auto-publish on or off.
- **Security and compliance**: OAuth with HMAC and state checks, app proxy signature checks, App Bridge session tokens for the admin API, webhook HMAC, and the GDPR webhooks (`customers/data_request`, `customers/redact`, `shop/redact`). The form has a honeypot field and a rate limit, and reviewer emails are never shown on the storefront.

## Structure

```
server/            Express backend (Node 22, built-in SQLite, no native deps)
  app.js           routes: /auth, /api/*, /proxy/*, /webhooks
  shopify.js       HMAC / session token / Admin GraphQL helpers
  db.js            SQLite storage
web/admin.html     embedded admin UI (App Bridge)
extensions/product-reviews/   theme app extension (blocks, JS, CSS, locales)
shopify.app.toml   app config (scopes, app proxy, webhooks)
test/              node:test suite
```

## Setup

1. Create an app in the [Shopify Partner Dashboard](https://partners.shopify.com) (or run `shopify app init` / `shopify app config link`).
2. `cp .env.example .env` and fill in `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET` and `SHOPIFY_APP_URL` (your public HTTPS URL).
3. In `shopify.app.toml`, replace `YOUR_CLIENT_ID` and every `your-app.example.com` with your values.
4. Install and run the backend:
   ```bash
   npm install
   npm test
   npm start
   ```
5. Push the config and the theme extension: `npm run deploy` (needs the [Shopify CLI](https://shopify.dev/docs/api/shopify-cli)).
6. Install the app on a development store: open `https://<SHOPIFY_APP_URL>/auth?shop=<store>.myshopify.com`.
7. In the theme editor, open a product template, then **Add block → Apps → Product reviews** (and **Star rating** if you want it).

New reviews start as **pending**. Approve them in **Apps → Product Reviews**, or turn on auto-publish.

## Quick guide (Roman Urdu)

1. Shopify Partner Dashboard mein app banayein aur Client ID / Secret `.env` mein daalein.
2. `npm install && npm start` se server chalayein. Server kisi public HTTPS URL par hona chahiye (jaise Render, Railway, Fly.io).
3. `shopify.app.toml` mein apna URL aur Client ID likhein, phir `npm run deploy` chalayein.
4. Store par app install karein, phir Theme editor mein product page par **Product reviews** block add karein.
5. Customers ke reviews admin mein **Apps → Product Reviews** mein aayenge. Wahan se approve ya reject karein.

## Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `GET /proxy/reviews?product_id=` | App proxy signature | Approved reviews and summary (storefront `/apps/reviews/reviews`) |
| `POST /proxy/reviews` | App proxy signature | Submit a review |
| `GET /api/reviews?status=` | Session token | List reviews for moderation |
| `PATCH /api/reviews/:id` | Session token | Change status (`pending` / `approved` / `rejected`) |
| `DELETE /api/reviews/:id` | Session token | Delete a review |
| `GET/PUT /api/settings` | Session token | Auto-publish setting |
| `POST /webhooks` | Webhook HMAC | Uninstall + GDPR webhooks |
