'use strict';
const { renderTemplate } = require('../telegram/bot');

function apiRouter({ store, pipeliner, config }) {
  const router = require('express').Router();

  router.get('/me', (req, res) => res.json({ ok: true, user: 'admin' }));

  router.get('/stats', (req, res) => res.json({ ...store.stats() }));

  router.get('/workouts', (req, res) => {
    const limit = Math.min(+req.query.limit || 50, 200);
    const offset = +req.query.offset || 0;
    const list = store.getWorkouts({ limit, offset });
    res.json({ items: list.map((w) => ({ id: w.id, title: w.title, workout_perform_date: w.workout_perform_date, workout_duration: w.workout_duration, total_volume: w.total_volume, workout_number: w.workout_number, workoutType: w.workout_type, card_path: w.card_path, picture_path: w.picture_path, telegram_sent: w.telegram_sent })) });
  });
  router.get('/workouts/:id', (req, res) => {
    const w = store.getWorkout(Number(req.params.id));
    if (!w) return res.status(404).json({ error: 'not found' });
    res.json(w);
  });

  router.get('/workouts/:id/card.jpg', (req, res) => {
    const w = store.getWorkout(Number(req.params.id));
    if (!w || !w.card_path) return res.status(404).end();
    res.type('image/jpeg').sendFile(w.card_path);
  });
  router.get('/workouts/:id/picture.jpg', (req, res) => {
    const w = store.getWorkout(Number(req.params.id));
    if (!w || !w.picture_path) return res.status(404).end();
    res.type('image/jpeg').sendFile(w.picture_path);
  });

  router.post('/workouts/:id/regenerate-card', async (req, res) => {
    try { await pipeliner.generateForWorkoutId(Number(req.params.id)); res.json({ ok: true }); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/workouts/:id/send-telegram', async (req, res) => {
    try {
      const wid = Number(req.params.id);
      const full = store.getWorkout(wid);
      if (!full.card_path) await pipeliner.generateForWorkoutId(wid);
      const token = store.setting('telegram_bot_token');
      const chatId = store.setting('telegram_chat_id');
      const cap = store.setting('telegram_caption') || '';
      if (!token || !chatId) return res.status(400).json({ error: 'Telegram not configured' });
      await pipeliner._sendWorkoutToTelegram(wid, token, chatId, cap);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/sync', async (req, res) => {
    try {
      const forceCard = !!req.body.forceCard;
      const ids = await pipeliner.runAll({ forceCard });
      res.json({ synced: ids.length, ids });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/regenerate-all', async (req, res) => {
    try {
      const result = await pipeliner.regenerateAllCards();
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.post('/telegram/send-all', async (req, res) => {
    try {
      const result = await pipeliner.sendAllToTelegram({ resetSent: !!req.body.resetSent });
      res.json(result);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // Settings get/set
  router.get('/settings', (req, res) => res.json({
    lyfta_email: store.setting('lyfta_email') || config.LYFTA_EMAIL,
    lyfta_device_id: store.setting('lyfta_device_id') || config.LYFTA_DEVICE_ID,
    telegram_bot_token: store.setting('telegram_bot_token'),
    telegram_chat_id: store.setting('telegram_chat_id'),
    telegram_enabled: store.setting('telegram_enabled'),
    telegram_caption: store.setting('telegram_caption') || defaultCaption(),
    sync_cron: store.setting('sync_cron') || '*/10 * * * *',
  }));
  router.post('/settings', (req, res) => {
    const body = req.body || {};
    for (const k of ['telegram_bot_token', 'telegram_chat_id', 'telegram_enabled', 'telegram_caption', 'sync_cron', 'lyfta_email', 'lyfta_device_id', 'lyfta_password']) {
      if (body[k] !== undefined) store.setting(k, String(body[k]));
    }
    res.json({ ok: true });
  });

  router.post('/test-telegram', async (req, res) => {
    try {
      const token = store.setting('telegram_bot_token');
      const chatId = store.setting('telegram_chat_id');
      const cap = store.setting('telegram_caption') || '';
      if (!token || !chatId) return res.status(400).json({ error: 'Telegram not configured' });
      const last = store.getWorkouts({ limit: 1 })[0];
      if (!last) return res.status(404).json({ error: 'no workouts to test with' });
      if (!last.card_path) await pipeliner.generateForWorkoutId(last.id);
      await pipeliner._sendWorkoutToTelegram(last.id, token, chatId, cap);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  router.get('/caption-preview', (req, res) => {
    const tpl = String(req.query.tpl || '');
    const sample = store.getWorkouts({ limit: 1 })[0] || { workout_perform_date: '2026-06-25 08:24', title: 'Sample', workout_duration: '00:48:13', total_volume: 2640, workout_number: 70, total_calories_burned: 180, body_weight: 79, exercises: new Array(5).fill({}) };
    const { setCount } = require('../lib/pipeline');
    res.json({ caption: renderTemplate(tpl, sample, setCount(sample)) });
  });

  router.get('/profile', (req, res) => {
    // Try to get any stored profile. The user_profiles table uses user_id as PK;
    // we try any workout's user_id, or any row in user_profiles.
    let profile = null;
    const w = store.getWorkouts({ limit: 1 })[0];
    if (w) profile = store.getUserProfile(w.user_id);
    if (!profile) {
      // Fall back to raw query for any profile row
      const row = store._prepare('SELECT * FROM user_profiles LIMIT 1').get();
      profile = row || null;
    }
    res.json({ profile });
  });

  router.get('/logs', (req, res) => {
    const limit = Math.min(+req.query.limit || 200, 1000);
    const offset = +req.query.offset || 0;
    res.json({ items: store.getLogs({ limit, offset }) });
  });

  router.post('/logs/clear', (req, res) => {
    store.clearLogs();
    res.json({ ok: true });
  });

  return router;
}

function defaultCaption() {
  return '🏋️ Workout #<workoutnumber> · <date>\n<title>\n\nDuration: <duration>\nWeight lifted: <volumeformatted>\nTotal sets: <totalsets>\nExercises: <exercises> · <calories> kcal burned';
}

module.exports = { apiRouter };