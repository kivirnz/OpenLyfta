'use strict';
const Database = require('better-sqlite3');
const path = require('node:path');
const fs = require('node:fs');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY,
  name TEXT,
  exercise_type TEXT,
  image_name TEXT,
  video_name TEXT,
  video_file TEXT,
  body_parts_json TEXT,
  equipments_json TEXT,
  primary_muscle_ids_json TEXT,
  synergist_muscle_ids_json TEXT,
  raw_json TEXT,
  synced_at INTEGER
);

CREATE TABLE IF NOT EXISTS workouts (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT,
  is_template INTEGER DEFAULT 0,
  color TEXT,
  note TEXT,
  description TEXT,
  total_volume REAL,
  total_lifted_weight REAL,
  total_calories_burned REAL,
  workout_duration TEXT,
  workout_perform_date TEXT,
  create_date TEXT,
  update_date TEXT,
  workout_number INTEGER,
  workout_type TEXT,
  template_id INTEGER,
  body_weight REAL,
  percieved_exertion INTEGER,
  privacy_setting TEXT,
  picture_url TEXT,
  picture_path TEXT,
  card_path TEXT,
  raw_json TEXT,
  synced_at INTEGER,
  telegram_sent INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workout_exercises (
  id INTEGER PRIMARY KEY,
  workout_id INTEGER NOT NULL,
  exercise_id INTEGER NOT NULL,
  excercise_name TEXT,
  exercise_type TEXT,
  exercise_image TEXT,
  exercise_note TEXT,
  exercise_rest_time INTEGER,
  exercise_superset_id INTEGER,
  is_completed INTEGER,
  weight_unit INTEGER,
  raw_json TEXT,
  FOREIGN KEY(workout_id) REFERENCES workouts(id)
);

CREATE TABLE IF NOT EXISTS workout_sets (
  id TEXT PRIMARY KEY,
  workout_id INTEGER NOT NULL,
  workout_excercise_id INTEGER,
  exercise_id INTEGER NOT NULL,
  weight TEXT,
  reps TEXT,
  rir TEXT,
  duration TEXT,
  distance TEXT,
  sets TEXT,
  set_type_id TEXT,
  is_completed INTEGER,
  record_type TEXT,
  record_level TEXT,
  record_value TEXT,
  date_create TEXT,
  update_date TEXT,
  raw_json TEXT,
  FOREIGN KEY(workout_id) REFERENCES workouts(id)
);

CREATE TABLE IF NOT EXISTS devices (
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_type TEXT,
  auth_token TEXT,
  last_login INTEGER,
  PRIMARY KEY(user_id, device_id)
);

CREATE TABLE IF NOT EXISTS sync_state (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS user_profiles (
  user_id TEXT PRIMARY KEY,
  username TEXT,
  email TEXT,
  first TEXT,
  last TEXT,
  gender TEXT,
  photo TEXT,
  weight TEXT,
  is_premium INTEGER DEFAULT 0,
  performed_workouts TEXT,
  raw_json TEXT,
  updated_at INTEGER
);

CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_workouts_user_date ON workouts(user_id, workout_perform_date DESC);
CREATE INDEX IF NOT EXISTS idx_sets_workout ON workout_sets(workout_id);
CREATE INDEX IF NOT EXISTS idx_ex_workout ON workout_exercises(workout_id);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);
`;

class Store {
  constructor(dbPath) {
    const dir = path.dirname(dbPath);
    fs.mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA);
    this._stmts = {};
  }

  _prepare(sql) {
    if (!this._stmts[sql]) this._stmts[sql] = this.db.prepare(sql);
    return this._stmts[sql];
  }

  setting(key, value) {
    if (value === undefined) {
      const r = this._prepare('SELECT value FROM settings WHERE key=?').get(key);
      return r ? r.value : null;
    }
    this._prepare('INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, String(value), Date.now());
    return value;
  }

  syncState(key, value) {
    if (value === undefined) {
      const r = this._prepare('SELECT value FROM sync_state WHERE key=?').get(key);
      return r ? r.value : null;
    }
    this._prepare('INSERT INTO sync_state(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at')
      .run(key, String(value), Date.now());
    return value;
  }

  upsertWorkout(w) {
    this.db.transaction(() => {
      this._prepare(`INSERT INTO workouts
       (id,user_id,title,is_template,color,note,description,total_volume,total_lifted_weight,total_calories_burned,
        workout_duration,workout_perform_date,create_date,update_date,workout_number,workout_type,template_id,
        body_weight,percieved_exertion,privacy_setting,picture_url,raw_json,synced_at)
       VALUES(@id,@user_id,@title,@is_template,@color,@note,@description,@total_volume,@total_lifted_weight,@total_calories_burned,
        @workout_duration,@workout_perform_date,@create_date,@update_date,@workout_number,@workout_type,@template_id,
        @body_weight,@percieved_exertion,@privacy_setting,@picture_url,@raw_json,@synced_at)
       ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,is_template=excluded.is_template,color=excluded.color,note=excluded.note,
        description=excluded.description,total_volume=excluded.total_volume,total_lifted_weight=excluded.total_lifted_weight,
        total_calories_burned=excluded.total_calories_burned,workout_duration=excluded.workout_duration,
        workout_perform_date=excluded.workout_perform_date,update_date=excluded.update_date,
        workout_number=excluded.workout_number,workout_type=excluded.workout_type,template_id=excluded.template_id,
        body_weight=excluded.body_weight,privacy_setting=excluded.privacy_setting,picture_url=excluded.picture_url,
        raw_json=excluded.raw_json,synced_at=excluded.synced_at`).run({
        id: w.id, user_id: String(w.user_id), title: w.title || '', is_template: w.is_template ? 1 : 0,
        color: w.color || null, note: w.note || '', description: w.description || '',
        total_volume: +w.total_volume || 0, total_lifted_weight: +w.totalLiftedWeight || 0,
        total_calories_burned: +w.total_calories_burned || 0, workout_duration: w.workout_duration || null,
        workout_perform_date: w.workout_perform_date || w.create_date || null,
        create_date: w.create_date || null, update_date: w.update_date || null,
        workout_number: w.workout_number || null, workout_type: w.workoutType || null,
        template_id: w.template_id || null, body_weight: +w.body_weight || null,
        percieved_exertion: Number.isFinite(+w.percieved_exertion) ? +w.percieved_exertion : 0,
        privacy_setting: w.privacy_setting || '0', picture_url: w.picture || null,
        raw_json: JSON.stringify(w), synced_at: Date.now(),
      });

      // Delete and re-insert exercises+sets for this workout (full snapshot per sync)
      this._prepare('DELETE FROM workout_sets WHERE workout_id=?').run(w.id);
      this._prepare('DELETE FROM workout_exercises WHERE workout_id=?').run(w.id);
      const insEx = this._prepare(`INSERT INTO workout_exercises
        (id,workout_id,exercise_id,excercise_name,exercise_type,exercise_image,exercise_note,exercise_rest_time,
         exercise_superset_id,is_completed,weight_unit,raw_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`);
      const insSet = this._prepare(`INSERT INTO workout_sets
        (id,workout_id,workout_excercise_id,exercise_id,weight,reps,rir,duration,distance,sets,set_type_id,
         is_completed,record_type,record_level,record_value,date_create,update_date,raw_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
      for (const ex of (w.exercises || [])) {
        insEx.run(ex.workout_excercise_id, w.id, ex.exercise_id, ex.excercise_name, ex.exercise_type,
          ex.exercise_image, ex.exercise_note, ex.exercise_rest_time, ex.exercise_superset_id,
          ex.is_completed ? 1 : 0, ex.weight_unit, JSON.stringify(ex));
        for (const s of (ex.sets || [])) {
          const set_id = String(s.id || `${w.id}-${ex.workout_excercise_id}-${Math.random().toString(36).slice(2, 8)}`);
          insSet.run(set_id, w.id, ex.workout_excercise_id, ex.exercise_id, s.weight ?? null, s.reps ?? null,
            s.rir ?? null, s.duration ?? null, s.distance ?? null, s.sets ?? null, s.set_type_id ?? null,
            s.is_completed ? 1 : 0, s.record_type ?? null, s.record_level ?? null, s.record_value ?? null,
            s.date_create ?? null, s.update_date ?? null, JSON.stringify(s));
        }
      }
    })();
  }

  upsertExercise(e) {
    const ids = (arr) => (arr || []).map((m) => Number(m.id)).filter(Boolean);
    this._prepare(`INSERT INTO exercises
      (id,name,exercise_type,image_name,video_name,video_file,body_parts_json,equipments_json,
       primary_muscle_ids_json,synergist_muscle_ids_json,raw_json,synced_at)
      VALUES(@id,@name,@exercise_type,@image_name,@video_name,@video_file,@body_parts_json,@equipments_json,
       @primary_muscle_ids_json,@synergist_muscle_ids_json,@raw_json,@synced_at)
      ON CONFLICT(id) DO UPDATE SET
       name=excluded.name,exercise_type=excluded.exercise_type,image_name=excluded.image_name,
       video_name=excluded.video_name,video_file=excluded.video_file,body_parts_json=excluded.body_parts_json,
       equipments_json=excluded.equipments_json,primary_muscle_ids_json=excluded.primary_muscle_ids_json,
       synergist_muscle_ids_json=excluded.synergist_muscle_ids_json,raw_json=excluded.raw_json,synced_at=excluded.synced_at`)
      .run({
        id: Number(e.id), name: e.name, exercise_type: e.exercise_type || null,
        image_name: e.image_name || null, video_name: e.video_name || null, video_file: e.video_file || null,
        body_parts_json: JSON.stringify(e.body_parts || []), equipments_json: JSON.stringify(e.equipments || []),
        primary_muscle_ids_json: JSON.stringify(ids(e.primary_muscles)),
        synergist_muscle_ids_json: JSON.stringify(ids(e.synergist_muscles)),
        raw_json: JSON.stringify(e), synced_at: Date.now(),
      });
  }

  getExercise(id) {
    const r = this._prepare('SELECT * FROM exercises WHERE id=?').get(id);
    if (!r) return null;
    return Object.assign(r, {
      body_parts: JSON.parse(r.body_parts_json || '[]'),
      equipments: JSON.parse(r.equipments_json || '[]'),
      primary_muscle_ids: JSON.parse(r.primary_muscle_ids_json || '[]'),
      synergist_muscle_ids: JSON.parse(r.synergist_muscle_ids_json || '[]'),
    });
  }

  // Update muscle IDs from catalog data (only if currently empty, so API data wins).
  supplementExerciseMuscleIds(id, primaryIds, synergistIds) {
    const ex = this.getExercise(id);
    if (!ex) return false;
    const hasPrimary = ex.primary_muscle_ids.length > 0;
    const hasSynergist = ex.synergist_muscle_ids.length > 0;
    if (hasPrimary && hasSynergist) return false;
    const newPrimary = hasPrimary ? ex.primary_muscle_ids : primaryIds;
    const newSynergist = hasSynergist ? ex.synergist_muscle_ids : synergistIds;
    this._prepare('UPDATE exercises SET primary_muscle_ids_json=?, synergist_muscle_ids_json=? WHERE id=?')
      .run(JSON.stringify(newPrimary), JSON.stringify(newSynergist), id);
    return true;
  }

  getWorkouts(opts = {}) {
    const limit = Math.min(+opts.limit || 50, 200);
    const offset = +opts.offset || 0;
    return this._prepare('SELECT * FROM workouts ORDER BY workout_perform_date DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  getWorkout(id) {
    const w = this._prepare('SELECT * FROM workouts WHERE id=?').get(id);
    if (!w) return null;
    const exs = this._prepare('SELECT * FROM workout_exercises WHERE workout_id=? ORDER BY id').all(id);
    for (const ex of exs) {
      ex.sets = this._prepare('SELECT * FROM workout_sets WHERE workout_excercise_id=? ORDER BY id').all(ex.id);
    }
    w.exercises = exs;
    if (w.raw_json) { Object.assign(w, JSON.parse(w.raw_json)); }
    return w;
  }

  setWorkoutPicturePath(id, p) { this._prepare('UPDATE workouts SET picture_path=? WHERE id=?').run(p, id); }
  setWorkoutCardPath(id, p) { this._prepare('UPDATE workouts SET card_path=? WHERE id=?').run(p, id); }
  markTelegramSent(id) { this._prepare('UPDATE workouts SET telegram_sent=1 WHERE id=?').run(id); }
  resetTelegramSent() { this._prepare('UPDATE workouts SET telegram_sent=0').run(); }
  telegramUnsent() { return this._prepare('SELECT * FROM workouts WHERE telegram_sent=0 AND card_path IS NOT NULL ORDER BY workout_perform_date ASC').all(); }
  telegramAll() { return this._prepare('SELECT * FROM workouts ORDER BY workout_perform_date ASC').all(); }

  saveDevice(d) {
    this._prepare('INSERT INTO devices(user_id,device_id,device_type,auth_token,last_login) VALUES(?,?,?,?,?) ON CONFLICT(user_id,device_id) DO UPDATE SET device_type=excluded.device_type,auth_token=excluded.auth_token,last_login=excluded.last_login')
      .run(d.user_id, d.device_id, d.device_type, d.auth_token, Date.now());
  }
  getDevice(user_id, device_id) {
    return this._prepare('SELECT * FROM devices WHERE user_id=? AND device_id=?').get(user_id, device_id);
  }

  stats() {
    return {
      workouts: this._prepare('SELECT COUNT(*) c FROM workouts').get().c,
      exercises: this._prepare('SELECT COUNT(*) c FROM exercises').get().c,
      sets: this._prepare('SELECT COUNT(*) c FROM workout_sets').get().c,
    };
  }

  saveUserProfile(p) {
    this._prepare(`INSERT INTO user_profiles
      (user_id,username,email,first,last,gender,photo,weight,is_premium,performed_workouts,raw_json,updated_at)
      VALUES(@user_id,@username,@email,@first,@last,@gender,@photo,@weight,@is_premium,@performed_workouts,@raw_json,@updated_at)
      ON CONFLICT(user_id) DO UPDATE SET
       username=excluded.username,email=excluded.email,first=excluded.first,last=excluded.last,
       gender=excluded.gender,photo=excluded.photo,weight=excluded.weight,is_premium=excluded.is_premium,
       performed_workouts=excluded.performed_workouts,raw_json=excluded.raw_json,updated_at=excluded.updated_at`)
      .run({
        user_id: String(p.id), username: p.username || null, email: p.email || null,
        first: p.first || null, last: p.last || null, gender: p.gender || null,
        photo: p.photo || null, weight: p.weight || null,
        is_premium: p.is_premium ? 1 : 0, performed_workouts: p.performed_workouts || null,
        raw_json: JSON.stringify(p), updated_at: Date.now(),
      });
  }

  getUserProfile(userId) {
    return this._prepare('SELECT * FROM user_profiles WHERE user_id=?').get(String(userId)) || null;
  }

  addLog(level, message) {
    this._prepare('INSERT INTO logs(ts,level,message) VALUES(?,?,?)').run(Date.now(), level, String(message));
  }

  getLogs(opts = {}) {
    const limit = Math.min(+opts.limit || 200, 1000);
    const offset = +opts.offset || 0;
    return this._prepare('SELECT id,ts,level,message FROM logs ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset);
  }

  clearLogs() {
    this._prepare('DELETE FROM logs').run();
  }

  close() { this.db.close(); }
}

module.exports = { Store };