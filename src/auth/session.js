'use strict';
const crypto = require('node:crypto');

// Minimal session/cookie auth. Single admin password from config or settings.
const TOKENS = new Map(); // sessionId -> expiry

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
        // first-run: install the provided password
        if (password && password.length >= 6) { store.setting('admin_password', password); return true; }
        return false;
      }
      if (!password || !crypto.timingSafeEqual(Buffer.from(String(password)), Buffer.from(String(target)))) return false;
      const sid = crypto.randomBytes(24).toString('hex');
      TOKENS.set(sid, Date.now() + 1000 * 60 * 60 * 12);
      return sid;
    },
    isAuthed(sessionId) {
      const e = TOKENS.get(sessionId);
      return !!e && e > Date.now();
    },
    logout(sessionId) { TOKENS.delete(sessionId); },
  };
}

function middleware(session) {
  return (req, res, next) => {
    const sid = (req.cookies && req.cookies.sid) || null;
    if (session.isAuthed(sid)) { req.sessionId = sid; return next(); }
    if (req.path.startsWith('/api/') || req.method !== 'GET') return res.status(401).json({ error: 'unauthorized' });
    // serve the login page for GET HTML
    res.type('html').status(401).send(LOGIN_HTML);
  };
}

const LOGIN_HTML = `<!doctype html><meta charset=utf-8><title>OpenLyfta · login</title>
<style>body{font-family:system-ui,sans-serif;background:#111317;color:#e9eaef;display:grid;place-items:center;height:100vh;margin:0}
.box{background:#191c23;padding:2.2rem;border-radius:16px;width:340px;box-shadow:0 4px 30px rgba(0,0,0,.3)}
h1{margin:0 0 1.4rem;font-size:1.3rem;font-weight:600}
input{width:100%;box-sizing:border-box;padding:.7rem;border:1px solid #2a2e38;border-radius:9px;background:#0e0f13;color:#eee;margin-bottom:.8rem}
button{width:100%;padding:.8rem;border:0;border-radius:9px;background:#EB445A;color:#fff;font-weight:600;cursor:pointer}
.hint{color:#7d818c;font-size:.8rem;margin-top:1rem;text-align:center}
</style><div class=box><h1>OpenLyfta</h1><form id=f><input type=password id=p placeholder=admin password><button>Sign in</button></form><div class=hint id=h></div></div>
<script>form.onsubmit=async e=>{e.preventDefault();const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:p.value})});if(r.ok){location='/'}else{h.textContent='Wrong password';h.style.color='#EB445A'}}</script>`;

module.exports = { makeSession, middleware };