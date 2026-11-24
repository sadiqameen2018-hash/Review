import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';

if (typeof process.loadEnvFile === 'function') {
  try { process.loadEnvFile(); } catch { /* no .env file */ }
}

const config = loadConfig();
const db = openDb(config.databasePath);
createApp({ config, db }).listen(config.port, () => {
  console.log(`Product Reviews app listening on :${config.port}`);
});
