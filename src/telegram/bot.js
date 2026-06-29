'use strict';
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

function tgRequest(token, method, form) {
  return new Promise((resolve, reject) => {
    const u = new URL(`https://api.telegram.org/bot${token}/${method}`);
    const bb = form.build();
    const req = https.request({
      method: 'POST', hostname: u.hostname, path: u.pathname,
      headers: { 'Content-Type': `multipart/form-data; boundary=${form.boundary}`, 'Content-Length': bb.length },
    }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c).toString('utf8') }));
    });
    req.on('error', reject);
    req.write(bb);
    req.end();
  });
}

class Multipart {
  constructor() { this.boundary = 'ol' + Math.random().toString(16).slice(2); this.parts = []; }
  field(name, val) {
    this.parts.push(Buffer.from(`--${this.boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${val}\r\n`));
    return this;
  }
  file(name, filename, contentType, buf) {
    this.parts.push(Buffer.from(`--${this.boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`));
    this.parts.push(buf);
    this.parts.push(Buffer.from('\r\n'));
    return this;
  }
  build() {
    this.parts.push(Buffer.from(`--${this.boundary}--\r\n`));
    return Buffer.concat(this.parts);
  }
}

function cleanTitle(t) {
  return String(t || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
}

const TOKENS = {
  date: (w) => (w.workout_perform_date || w.create_date || '').slice(0, 16).replace('T', ' '),
  workoutname: (w) => cleanTitle(w.title || ''),
  title: (w) => cleanTitle(w.title || ''),
  duration: (w) => w.workout_duration || '',
  volume: (w, _s, unit) => {
    const n = Math.round(+(w.total_volume || w.totalLiftedWeight || 0));
    if (unit === 'lbs') return String(Math.round(n * 2.20462));
    return String(n);
  },
  volumeformatted: (w, _s, unit) => {
    const n = Math.round(+(w.total_volume || w.totalLiftedWeight || 0));
    if (unit === 'lbs') return Math.round(n * 2.20462).toLocaleString('en-US') + 'lbs';
    return n.toLocaleString('en-US') + 'kg';
  },
  totalsets: (w, sets) => String(sets),
  exercises: (w) => String((w.exercises || []).length),
  workoutnumber: (w) => String(w.workout_number || ''),
  calories: (w) => String(w.total_calories_burned || 0),
  bodyweight: (w, _s, unit) => {
    const n = Math.round(+(w.body_weight || 0));
    if (unit === 'lbs') return String(Math.round(n * 2.20462));
    return String(n);
  },
};

function renderTemplate(tpl, workout, sets, unit, opts) {
  return (tpl || '').replace(/<([a-zA-Z0-9_]+)>/g, (_, k) => {
    if (k.toLowerCase() === 'sharelink') return (opts && opts.shareUrl) ? opts.shareUrl : '';
    const fn = TOKENS[k.toLowerCase()];
    return fn ? String(fn(workout, sets, unit) || '') : `<${k}>`;
  });
}

async function sendCard({ botToken, chatId, cardPath, caption, workout, totalSets, unit, shareUrl }) {
  const cap = caption != null ? renderTemplate(caption, workout, totalSets, unit, { shareUrl }) : '';
  const form = new Multipart();
  form.field('chat_id', chatId);
  form.file('photo', path.basename(cardPath), 'image/jpeg', fs.readFileSync(cardPath));
  if (cap) form.field('caption', cap.length > 1024 ? cap.slice(0, 1021) + '...' : cap);
  const r = await tgRequest(botToken, 'sendPhoto', form);
  if (r.status >= 400) throw new Error(`Telegram sendPhoto ${r.status}: ${r.body}`);
  return true;
}

module.exports = { sendCard, renderTemplate, TOKENS };