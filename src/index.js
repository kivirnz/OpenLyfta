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

  // --- Auth routes (no auth required) ---
  app.post('/api/login', (req, res) => {
    const sid = session.login((req.body || {}).password || '');
    if (!sid) return res.status(401).json({ error: 'invalid' });
    res.cookie('sid', sid, { httpOnly: true, sameSite: 'lax', maxAge: 1000 * 60 * 60 * 12 });
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    session.logout(req.cookies && req.cookies.sid);
    res.clearCookie('sid');
    res.json({ ok: true });
  });

  app.get('/login', (req, res) => {
    const sid = (req.cookies && req.cookies.sid) || null;
    if (session.isAuthed(sid)) return res.redirect('/');
    res.type('html').status(200).send(LOGIN_PAGE);
  });

  // --- Protected API routes ---
  app.use('/api', (req, res, next) => authMiddleware(session)(req, res, next), apiRouter({ store, pipeliner, config, logger }));

  // --- Static files (public assets like logos, favicons — NOT the dashboard) ---
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // --- Dashboard (auth required) ---
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

const LOGIN_PAGE = `<!doctype html><meta charset=utf-8><title>OpenLyfta · login</title>
<link rel=icon type=image/png href=/stickfigure.png>
<style>body{font-family:system-ui,sans-serif;background:#111317;color:#e9eaef;display:grid;place-items:center;height:100vh;margin:0}
.box{background:#191c23;padding:2.2rem;border-radius:16px;width:340px;box-shadow:0 4px 30px rgba(0,0,0,.3)}
h1{margin:0 0 1.4rem;font-size:1.3rem;font-weight:600}
input{width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #2a2e38;border-radius:9px;background:#0e0f13;color:#eee;margin-bottom:.8rem}
button{width:100%;padding:.8rem;border:0;border-radius:9px;background:#EB445A;color:#fff;font-weight:600;cursor:pointer}
.hint{color:#7d818c;font-size:.8rem;margin-top:1rem;text-align:center}
</style><div class=box><h1>OpenLyfta</h1><form id=f><input type=password id=p placeholder="admin password"><button>Sign in</button></form><div class=hint id=h></div></div>
<script>document.getElementById('f').onsubmit=async function(e){e.preventDefault();var pw=document.getElementById('p').value;var hint=document.getElementById('h');try{var r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})});if(r.ok){window.location.href='/';}else{hint.textContent='Wrong password';hint.style.color='#EB445A';}}catch(err){hint.textContent='Error: '+err;hint.style.color='#EB445A';}}</script>`;

main().catch((e) => { console.error(e); process.exit(1); });