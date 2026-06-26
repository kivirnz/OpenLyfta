'use strict';
const crypto = require('node:crypto');

const TOKENS = new Map();

function makeSession(store) {
  const pw = () => {
    const cfgPw = process.env.OPENLYFTA_ADMIN_PASSWORD;
    if (cfgPw) return cfgPw;
    return store.setting('admin_password');
  };
  return {
    login(password) {
      const target = pw();
      if (!target) {
        if (password && password.length >= 6) {
          store.setting('admin_password', password);
        } else {
          return false;
        }
      } else {
        const a = Buffer.from(String(password));
        const b = Buffer.from(String(target));
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
      }
      const sid = crypto.randomBytes(24).toString('hex');
      TOKENS.set(sid, Date.now() + 1000 * 60 * 60 * 12);
      return sid;
    },
    isAuthed(sessionId) {
      const e = TOKENS.get(sessionId);
      return !!e && e > Date.now();
    },
    logout(sessionId) {
      if (sessionId) TOKENS.delete(sessionId);
    },
  };
}

function middleware(session) {
  return (req, res, next) => {
    const sid = (req.cookies && req.cookies.sid) || null;
    if (session.isAuthed(sid)) { req.sessionId = sid; return next(); }
    if (req.path.startsWith('/api/') || req.method !== 'GET') return res.status(401).json({ error: 'unauthorized' });
    return res.redirect('/login');
  };
}

module.exports = { makeSession, middleware };