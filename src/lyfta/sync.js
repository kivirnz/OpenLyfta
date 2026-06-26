'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { LyftaClient } = require('./client');

class Syncer {
  constructor({ store, config, onWorkout, logger = console }) {
    this.store = store;
    this.logger = logger;
    this.onWorkout = onWorkout || (() => {});
    this.client = new LyftaClient({
      email: config.LYFTA_EMAIL,
      password: config.LYFTA_PASSWORD,
      device_id: config.LYFTA_DEVICE_ID,
      device_type: config.LYFTA_DEVICE_TYPE || 'A',
    });
    this.mediaDir = config.MEDIA_DIR || path.join(process.cwd(), 'data', 'media');
    this.catalogDir = config.CATALOG_DIR || path.join(process.cwd(), 'data', 'catalog');
    fs.mkdirSync(this.mediaDir, { recursive: true });
    fs.mkdirSync(this.catalogDir, { recursive: true });
  }

  async ensureAuth() {
    if (this.client.authToken) {
      const saved = this.store.getDevice(this.client.userId, this.client.device_id);
      if (saved && saved.auth_token === this.client.authToken) return;
    }
    // Re-read credentials from store on each login (dashboard settings may change after boot)
    const email = this.store.setting('lyfta_email') || this.client.email;
    const password = this.store.setting('lyfta_password') || this.client.password;
    this.client.email = email;
    this.client.password = password;
    if (!email || !password) throw new Error('Lyfta credentials not configured. Set email and password in Settings.');
    const data = await this.client.login();
    this.store.saveDevice({ user_id: data.id, device_id: this.client.device_id, device_type: this.client.device_type, auth_token: data.auth_token });
    this.logger.log(`[sync] logged in as user ${data.id}`);
  }

  // Fetch user profile from viewProfileGraph and store in user_profiles table.
  // This is the ONLY source of gender info — workouts no longer carry gender.
  async fetchUserProfile() {
    await this.ensureAuth();
    const j = await this.client.viewProfileGraph();
    if (j.data) {
      this.store.saveUserProfile(j.data);
      this.logger.log(`[sync] user profile updated: ${j.data.first || ''} ${j.data.last || ''} (gender=${j.data.gender || 'none'})`);
    }
    return j.data || null;
  }

  // GET https://apilyfta.com/sync/forwardToCloudFront?user_id=XXX -> 302 Location header
  // returns the gender-tagged exercises JSON URL for THIS user.
  async discoverCatalogUrl() {
    await this.ensureAuth();
    const path = `/sync/forwardToCloudFront?user_id=${encodeURIComponent(this.client.userId)}`;
    const res = await this.client._get(path);
    if (res.status !== 302) throw new Error(`forwardToCloudFront unexpected status ${res.status}`);
    const loc = res.headers.location;
    if (!loc) throw new Error('forwardToCloudFront returned no Location header');
    return loc;
  }

  // Download + cache the gender-appropriate exercise catalog. Refreshed regularly.
  // The catalog only carries Target_muscles_id / Synergist_muscles_id (ids, no names);
  // we still use getMultipleExercises for human-readable names, but the catalog lets us
  // map exercise_id -> muscle ids WITHOUT an extra API call when generating cards.
  async refreshCatalog() {
    let url = await this.discoverCatalogUrl().catch(() => null);
    let cachedUrl = this.store.syncState('catalog_url');
    const changed = url && url !== cachedUrl;
    if (!url) { // fall back to last known
      if (!cachedUrl) return null;
      url = cachedUrl;
    }
    if (changed || !this.store.syncState('catalog_synced_at')) {
      const buf = await this.client.fetchAsset(url);
      const dest = path.join(this.catalogDir, path.basename(new URL(url).pathname));
      fs.writeFileSync(dest, buf);
      this.store.syncState('catalog_url', url);
      this.store.syncState('catalog_path', dest);
      this.store.syncState('catalog_synced_at', String(Date.now()));
      this.logger.log(`[sync] refreshed exercise catalog from ${url}`);
      return dest;
    }
    return this.store.syncState('catalog_path');
  }

  static async _download(client, url, dest) {
    if (fs.existsSync(dest)) return dest;
    const buf = await client.fetchAsset(url);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    return dest;
  }

  // Full sync: walk feed pages + backfill older via get_all_user_workouts.
  async runFull({ forceCard = false } = {}) {
    await this.ensureAuth();
    await this.fetchUserProfile().catch((e) => this.logger.warn(`[sync] profile fetch failed: ${e.message}`));
    await this.refreshCatalog().catch((e) => this.logger.warn(`[sync] catalog refresh failed: ${e.message}`));
    await this._syncExercisesKnown();
    await this.supplementFromCatalog();
    const newWorkoutIds = [];

    // 1) walk feed "you" pages until we hit workouts already stored
    let offset = 0;
    const limit = 6;
    let pagesDone = 0;
    let maxPages = 100;
    let stopped = false;
    while (!stopped && pagesDone < maxPages) {
      const { workouts, totalPages } = await this.client.getFeeds({ offset, limit, type: 'you' });
      pagesDone++;
      if (!workouts.length) break;
      for (const w of workouts) {
        const existed = !!this.store.getWorkout(w.id);
        this.store.upsertWorkout(w);
        await this._downloadWorkoutPicture(w);
        newWorkoutIds.push(w.id);
        if (existed && !forceCard) { stopped = true; break; }
      }
      this.store.syncState('feed_offset', String(offset + workouts.length));
      offset += workouts.length;
      if (offset >= (totalPages || 0) * limit) break;
    }

    // 2) Backfill: get_all_user_workouts (older than feed window) for bodies we don't have
    const backfill = await this.client.getAllUserWorkouts({ offset: 0, limit: 250 });
    for (const w of backfill.workouts) {
      if (this.store.getWorkout(w.id)) continue; // already handled above
      this.store.upsertWorkout(w);
      await this._downloadWorkoutPicture(w);
      newWorkoutIds.push(w.id);
    }

    this.logger.log(`[sync] ${newWorkoutIds.length} workouts synced. exercises in db: ${this.store.stats().exercises}`);
    // Trigger card gen + telegram for any not-yet-sent
    return newWorkoutIds;
  }

  async _downloadWorkoutPicture(w) {
    if (!w.picture) return;
    const dest = path.join(this.mediaDir, 'picture', `${w.id}${path.extname(new URL(w.picture).pathname) || '.jpeg'}`);
    try {
      await Syncer._download(this.client, w.picture, dest);
      this.store.setWorkoutPicturePath(w.id, dest);
    } catch (e) {
      this.logger.warn(`[sync] picture download failed for ${w.id}: ${e.message}`);
    }
  }

  // Pull muscle data for all exercises referenced in captured workouts (batched).
  async _syncExercisesKnown() {
    const ids = new Set();
    for (const w of this.store.getWorkouts({ limit: 200 })) {
      const full = this.store.getWorkout(w.id);
      for (const ex of (full.exercises || [])) ids.add(Number(ex.exercise_id));
    }
    // Also ensure any cached ids from prior runs
    const haveIds = this._prepareExerciseIds([...ids]);
    const want = haveIds.filter((id) => !this.store.getExercise(id));
    for (let i = 0; i < want.length; i += 20) {
      const batch = want.slice(i, i + 20);
      try {
        const exs = await this.client.getMultipleExercises(batch);
        for (const e of exs) this.store.upsertExercise(e);
      } catch (e) {
        this.logger.warn(`[sync] exercise batch ${batch.join(',')} failed: ${e.message}`);
      }
    }
  }

  _prepareExerciseIds(ids) { return Array.from(new Set(ids.map(Number).filter(Boolean))); }

  // Parse the cached catalog JSON and supplement any exercises missing muscle IDs.
  // Catalog fields: id, Target_muscles_id, Synergist_muscles_id (comma-separated id lists).
  async supplementFromCatalog() {
    const catalogPath = this.store.syncState('catalog_path');
    if (!catalogPath || !fs.existsSync(catalogPath)) return 0;
    let entries;
    try { entries = JSON.parse(fs.readFileSync(catalogPath, 'utf8')); }
    catch { return 0; }
    if (!Array.isArray(entries)) return 0;
    let updated = 0;
    for (const e of entries) {
      const id = Number(e.id);
      if (!id) continue;
      const primary = String(e.Target_muscles_id || e.target_muscles_id || '')
        .split(',').map((s) => Number(s.trim())).filter(Boolean);
      const synergist = String(e.Synergist_muscles_id || e.synergist_muscles_id || '')
        .split(',').map((s) => Number(s.trim())).filter(Boolean);
      if (primary.length || synergist.length) {
        if (this.store.supplementExerciseMuscleIds(id, primary, synergist)) updated++;
      }
    }
    this.logger.log(`[sync] catalog supplemented ${updated} exercises with muscle IDs`);
    return updated;
  }

  async syncExercisesFor(workout) {
    const ids = (workout.exercises || []).map((e) => Number(e.exercise_id)).filter(Boolean);
    const want = this._prepareExerciseIds(ids).filter((id) => !this.store.getExercise(id));
    for (let i = 0; i < want.length; i += 20) {
      const batch = want.slice(i, i + 20);
      try {
        const exs = await this.client.getMultipleExercises(batch);
        for (const e of exs) this.store.upsertExercise(e);
      } catch (e) { this.logger.warn(`[sync] exercise batch ${batch.join(',')}: ${e.message}`); }
    }
  }
}

module.exports = { Syncer };