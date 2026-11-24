export function loadConfig(env = process.env) {
  const config = {
    apiKey: env.SHOPIFY_API_KEY,
    apiSecret: env.SHOPIFY_API_SECRET,
    appUrl: (env.SHOPIFY_APP_URL || '').replace(/\/$/, ''),
    scopes: env.SCOPES || 'write_products',
    apiVersion: env.SHOPIFY_API_VERSION || '2026-10',
    port: Number(env.PORT || 3000),
    databasePath: env.DATABASE_PATH || './data/reviews.sqlite',
  };
  const missing = ['apiKey', 'apiSecret', 'appUrl'].filter((k) => !config[k]);
  if (missing.length) {
    throw new Error(`Missing config: ${missing.join(', ')} (see .env.example)`);
  }
  return config;
}
