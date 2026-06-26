'use strict';
require('dotenv').config();
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const cookieParser = require('cookie-parser');
const compression = require('compression');
const cron = require('node-cron');
const { Store } = require('./store');
const { Syncer } = require('./lyfta/sync');
const { Pipeliner } = require('./lib/pipeline');
const { createLogger } = require('./lib/logger');
const { makeSession, middleware: authMiddleware } = require('./auth/session');
const { apiRouter } = require('./routes/api');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'media', 'picture'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'cards'), { recursive: true });

const PUBLIC_DIR = path.join(__dirname, '..', 'public');


async function main() {
  const store = new Store(path.join(DATA_DIR, 'openlyfta.db'));
  const logger = createLogger(store);
  const config = {
    MEDIA_DIR: path.join(DATA_DIR, 'media'),
    CARD_DIR: path.join(DATA_DIR, 'cards'),
    LYFTA_EMAIL: store.setting('lyfta_email') || process.env.LYFTA_EMAIL,
    LYFTA_PASSWORD: process.env.LYFTA_PASSWORD || store.setting('lyfta_password'),
    LYFTA_DEVICE_ID: store.setting('lyfta_device_id') || process.env.LYFTA_DEVICE_ID || 'OpenLyfta, Server, 14',
    LYFTA_DEVICE_TYPE: process.env.LYFTA_DEVICE_TYPE || 'A',
  };

  if (!config.LYFTA_EMAIL || !config.LYFTA_PASSWORD) {
    logger.warn('[boot] No Lyfta credentials configured. Set them in the web UI or env (LYFTA_EMAIL/LYFTA_PASSWORD).');
  }

  const syncer = new Syncer({ store, config, logger });
  const pipeliner = new Pipeliner({ store, syncer, config, logger });

  const session = makeSession(store);
  const app = express();
  app.use(compression());
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  // API routes that handle their own auth (login)
  app.use('/api/login', express.raw({ type: '*/*' }));
  app.post('/api/login', express.json(), (req, res) => {
    const sid = session.login((req.body || {}).password || '');
    if (!sid) return res.status(401).json({ error: 'invalid' });
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 });
    res.json({ ok: true });
  });

  // Everything under /api/* (except login) and dashboard requires auth
  app.use('/api', (req, res, next) => {
    if (req.path === '/login') return next();
    authMiddleware(session)(req, res, next);
  }, apiRouter({ store, pipeliner, config, logger }));

  // Public static + dashboard
  app.use(express.static(PUBLIC_DIR));
  app.get('/', authMiddleware(session), (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

  // Cron-driven full pipeline
  let cronTask = null;
  function scheduleCron() {
    if (cronTask) cronTask.stop();
    const expr = store.setting('sync_cron') || '*/10 * * * *';
    if (!cron.validate(expr)) { logger.warn(`[boot] bad cron '${expr}'`); return; }
    cronTask = cron.schedule(expr, async () => {
      if (!config.LYFTA_EMAIL || !process.env.LYFTA_PASSWORD && !store.setting('lyfta_password')) return;
      try {
        const Syncer2 = require('./lyfta/sync');
        const s2 = new Syncer2({ store, config: { ...config, LYFTA_PASSWORD: process.env.LYFTA_PASSWORD || store.setting('lyfta_password') }, logger });
        const p2 = new (require('./lib/pipeline').Pipeliner)({ store, syncer: s2, config, logger });
        await p2.runAll();
        logger.log('[cron] full sync complete');
      } catch (e) { logger.warn('[cron] sync failed:', e.message); }
    });
    logger.log(`[boot] scheduled cron '${expr}'`);
  }
  scheduleCron();

  const port = +process.env.PORT || 3000;
  app.listen(port, '0.0.0.0', () => logger.log(`[OpenLyfta] listening on :${port}`));

  // one initial sync after boot if credentials present
  if (config.LYFTA_EMAIL && (process.env.LYFTA_PASSWORD || store.setting('lyfta_password'))) {
    setTimeout(() => pipeliner.runAll().catch((e) => logger.warn('[boot] initial sync failed:', e.message)), 3500);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });