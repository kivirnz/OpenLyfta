'use strict';
const https = require('node:https');
const { URL } = require('node:url');

const UA = 'Lyfta/1.528 (Android)';
const HOST = 'lyftadev.com';

function request({ method = 'POST', hostname = HOST, path: _path, authToken, body }) {
  return new Promise((resolve, reject) => {
    const u = new URL(_path, `https://${hostname}`);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const headers = {
      'User-Agent': UA,
      'Host': u.host,
      'Connection': 'Keep-Alive',
      'Accept-Encoding': 'identity',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = payload.length;
    }
    if (authToken) headers['Auth-Token'] = authToken;

    const req = https.request({
      method, hostname: u.hostname, port: 443,
      path: u.pathname.replace(/\/+/g, '/') + u.search,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function parseBody(res) {
  let body = res.body;
  const enc = (res.headers['content-encoding'] || '').toLowerCase();
  if (enc.includes('gzip')) {
    const zlib = require('node:zlib');
    body = zlib.unzipSync(body);
  }
  let str = body.toString('utf8').trim();
  // Lyfta occasionally prefixes a leading space
  if (str.charAt(0) === ' ') str = str.trim();
  if (!str) return null;
  try { return JSON.parse(str); }
  catch {
    // Some endpoints return inline JSON-as-string data; the data field may itself be a string
    throw new Error(`Bad JSON from Lyfta (${res.status}): ${str.slice(0, 200)}`);
  }
}

class LyftaClient {
  constructor({ email, password, device_id = 'OpenLyfta, Server, 14', device_type = 'A' }) {
    this.email = email;
    this.password = password;
    this.device_id = device_id;
    this.device_type = device_type;
    this.userId = null;
    this.authToken = null;
  }

  setAuth(userId, authToken) { this.userId = String(userId); this.authToken = authToken; }

  async login() {
    const res = await request({
      path: '/webservice/login',
      body: { password: this.password, device_id: this.device_id, device_type: this.device_type, email: this.email },
    });
    const j = await parseBody(res);
    if (!j || !j.status || !j.data || !j.data.auth_token) {
      throw new Error(`Lyfta login failed: ${(j && j.message) || res.status}`);
    }
    this.setAuth(j.data.id, j.data.auth_token);
    return j.data;
  }

  async _post(path, body) {
    if (!this.authToken) await this.login();
    let res = await request({ path, authToken: this.authToken, body });
    if (res.status === 401 || res.status === 403) {
      await this.login();
      res = await request({ path, authToken: this.authToken, body });
    }
    const j = await parseBody(res);
    return j;
  }

  async _get(path) {
    if (!this.authToken) await this.login();
    let res = await request({ method: 'GET', path, authToken: this.authToken });
    if (res.status === 401 || res.status === 403) { await this.login(); res = await request({ method: 'GET', path, authToken: this.authToken }); }
    return res;
  }

  // Feed (last ~6 workouts/page). type: 'you' | 'all'
  async getFeeds({ offset = 0, limit = 6, type = 'you' } = {}) {
    const j = await this._post('/feed/getFeedsV9', { offset, user_id: this.userId, limit, type });
    if (!j || !j.status) throw new Error(`getFeedsV9 failed: ${(j && j.message) || 'no status'}`);
    return {
      workouts: Array.isArray(j.data) ? j.data : [],
      totalPages: Number(j.totalPages || 0),
    };
  }

  async getAllUserWorkouts({ offset = 0, limit = 250 } = {}) {
    const j = await this._post('/sync/get_all_user_workouts', { offset, user_id: this.userId, limit });
    if (!j || !j.status) throw new Error(`get_all_user_workouts failed: ${(j && j.message) || 'no status'}`);
    // data is an array of timeline rows whose .data is a JSON string of the workout shape
    const rows = Array.isArray(j.data) ? j.data : [];
    const workouts = [];
    for (const r of rows) {
      const inner = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
      if (inner && inner.exercises) workouts.push(inner);
    }
    return { workouts, rows };
  }

  async getMultipleExercises(ids) {
    if (!ids.length) return [];
    const j = await this._post('/webservice/getMultipleExercises', { user_id: this.userId, excercises: ids });
    if (!j || !j.status) throw new Error(`getMultipleExercises failed: ${(j && j.message) || 'no status'}`);
    return Array.isArray(j.data) ? j.data : [];
  }

  async getSingleWorkoutCalendar(workout_id) {
    const j = await this._post('/webservice/getSingleWorkout_calendar', { user_id: this.userId, workout_id });
    return j;
  }

  async viewProfileGraph() {
    const j = await this._post('/webservice/viewProfileGraph', { subscription_id: '2', user_id: this.userId });
    if (!j || !j.status) throw new Error(`viewProfileGraph failed: ${(j && j.message) || 'no status'}`);
    return j;
  }

  async fetchAsset(url, { expectStatus = [200] } = {}) {
    const u = new URL(url);
    const res = await request({ method: 'GET', hostname: u.hostname, path: u.pathname + (u.search || '') });
    if (!expectStatus.includes(res.status)) throw new Error(`Asset fetch ${url} -> ${res.status}`);
    return res.body;
  }
}

module.exports = { LyftaClient };