'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { generateCard } = require('../image/card');
const { sendCard } = require('../telegram/bot');

function setCount(workout) {
  let n = 0;
  for (const ex of (workout.exercises || [])) n += (ex.sets || []).length;
  return n;
}

class Pipeliner {
  constructor({ store, syncer, config, logger = console }) {
    this.store = store;
    this.syncer = syncer;
    this.config = config;
    this.logger = logger || console;
    this.cardDir = config.CARD_DIR || path.join(process.cwd(), 'data', 'cards');
    fs.mkdirSync(this.cardDir, { recursive: true });
  }

  // Collect primary muscle ids across all exercises in a workout from exercise metadata.
  muscleIdsForWorkout(workout) {
    const primary = new Set();
    const secondary = new Set();
    for (const ex of (workout.exercises || [])) {
      const meta = this.store.getExercise(Number(ex.exercise_id));
      if (!meta) continue;
      for (const id of (meta.primary_muscle_ids || [])) primary.add(id);
      for (const id of (meta.synergist_muscle_ids || [])) secondary.add(id);
    }
    return { primary: [...primary], secondary: [...secondary] };
  }

  async generateForWorkoutId(id) {
    const workout = this.store.getWorkout(id);
    if (!workout) throw new Error(`workout ${id} not found`);
    if (!workout.picture_path || !fs.existsSync(workout.picture_path)) {
      throw new Error(`workout ${id} has no local picture`);
    }
    const { primary, secondary } = this.muscleIdsForWorkout(workout);
    const profile = this.store.getUserProfile(workout.user_id);
    const gender = profile ? profile.gender : null;
    const outPath = path.join(this.cardDir, `${id}.jpg`);
    await generateCard(workout, { primaryMuscleIds: primary, secondaryMuscleIds: secondary, outPath, gender, logger: this.logger });
    this.store.setWorkoutCardPath(id, outPath);
    return outPath;
  }

  async drainTelegram() {
    const tgBotToken = this.store.setting('telegram_bot_token');
    const tgChatId = this.store.setting('telegram_chat_id');
    const enabled = this.store.setting('telegram_enabled') === '1';
    if (!enabled || !tgBotToken || !tgChatId) return { sent: 0 };
    const captionTpl = this.store.setting('telegram_caption') || '';
    const queue = this.store.telegramUnsent();
    let sent = 0;
    for (const w of queue) {
      try {
        if (!w.card_path) {
          await this.generateForWorkoutId(w.id);
        }
        const full = this.store.getWorkout(w.id);
        await sendCard({ botToken: tgBotToken, chatId: tgChatId, cardPath: full.card_path, caption: captionTpl, workout: full, totalSets: setCount(full) });
        this.store.markTelegramSent(w.id);
        sent++;
      } catch (e) {
        this.logger.warn(`[pipeline] telegram send failed for ${w.id}: ${e.message}`);
      }
    }
    return { sent };
  }

  // Send ALL workouts (including already-sent) to Telegram. Used for bulk history import.
  // If resetSent is true, marks all workouts as unsent first (so they will all be queued).
  async sendAllToTelegram({ resetSent = false } = {}) {
    const tgBotToken = this.store.setting('telegram_bot_token');
    const tgChatId = this.store.setting('telegram_chat_id');
    if (!tgBotToken || !tgChatId) throw new Error('Telegram not configured');
    const captionTpl = this.store.setting('telegram_caption') || '';
    if (resetSent) this.store.resetTelegramSent();
    const queue = this.store.telegramAllWithPictures();
    let sent = 0;
    let failed = 0;
    this.logger.log(`[pipeline] sending ${queue.length} workouts to Telegram`);
    for (const w of queue) {
      try {
        if (!w.card_path || !require('node:fs').existsSync(w.card_path)) {
          await this.generateForWorkoutId(w.id);
        }
        const full = this.store.getWorkout(w.id);
        if (!full.card_path) { failed++; continue; }
        await sendCard({ botToken: tgBotToken, chatId: tgChatId, cardPath: full.card_path, caption: captionTpl, workout: full, totalSets: setCount(full) });
        this.store.markTelegramSent(w.id);
        sent++;
        this.logger.log(`[pipeline] sent workout ${w.id} (${sent}/${queue.length})`);
      } catch (e) {
        failed++;
        this.logger.warn(`[pipeline] telegram send failed for ${w.id}: ${e.message}`);
      }
    }
    this.logger.log(`[pipeline] bulk send complete: ${sent} sent, ${failed} failed`);
    return { sent, failed, total: queue.length };
  }

  async regenerateAllCards() {
    const workouts = this.store.getWorkouts({ limit: 10000 });
    let ok = 0, failed = 0;
    for (const w of workouts) {
      try {
        await this.generateForWorkoutId(w.id);
        ok++;
      } catch (e) {
        failed++;
        this.logger.warn(`[pipeline] card regen failed for ${w.id}: ${e.message}`);
      }
    }
    this.logger.log(`[pipeline] card regen complete: ${ok} ok, ${failed} failed`);
    return { ok, failed, total: workouts.length };
  }

  async runAll({ forceCard = false } = {}) {
    const ids = await this.syncer.runFull({ forceCard });
    // After sync, ensure exercise muscle data is current then build cards for new workouts
    for (const id of ids) {
      if (!forceCard) { try { await this.syncer.syncExercisesFor(this.store.getWorkout(id)); } catch {} }
      try { await this.generateForWorkoutId(id); } catch (e) { this.logger.warn(`[pipeline] card gen failed for ${id}: ${e.message}`); }
    }
    await this.drainTelegram();
    return ids;
  }
}

module.exports = { Pipeliner, setCount };