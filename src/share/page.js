'use strict';

function decodeUnicode(t) {
  return String(t || '').replace(/\\u([0-9a-fA-F]{4})/g, (_, c) => String.fromCharCode(parseInt(c, 16)));
}

function cleanTitle(t) {
  if (!t) return 'Untitled Workout';
  return decodeUnicode(t);
}

function fmtDate(d) {
  return (d || '').replace('T', ' ').slice(0, 16);
}

function fmtWeight(w, unit) {
  const n = parseFloat(w) || 0;
  let val = n;
  if (unit === 'lbs') val = n * 2.20462;
  const rounded = Math.round(val * 10) / 10;
  const display = rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded);
  return display + (unit === 'lbs' ? 'lbs' : 'kg');
}

function fmtVolume(v, unit) {
  const n = Math.round(+v || 0);
  if (unit === 'lbs') return Math.round(n * 2.20462).toLocaleString('en-US') + 'lbs';
  return n.toLocaleString('en-US') + 'kg';
}

const EXERCISE_TYPES = {
  weight_reps: { label: 'Weight × Reps', color: '#3b82f6' },
  db_1_both_sides: { label: '1 Dumbbell · Both Sides', color: '#a855f7' },
  db_2_simultaneous: { label: '2 Dumbbells', color: '#a855f7' },
  db_1: { label: '1 Dumbbell', color: '#a855f7' },
  bodyweight: { label: 'Bodyweight', color: '#22c55e' },
  bodyweight_assisted: { label: 'Bodyweight Assisted', color: '#22c55e' },
  duration: { label: 'Duration', color: '#f59e0b' },
  distance: { label: 'Distance', color: '#f59e0b' },
  reps_only: { label: 'Reps Only', color: '#6b7280' },
};

const RECORD_TYPES = {
  1: 'Est. 1RM',
  2: 'Max Weight',
  3: 'Max Set Volume',
  4: 'Max Reps',
};

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function parseRecords(set) {
  if (!set.record_type || !set.record_value) return [];
  const types = String(set.record_type).split(',');
  const values = String(set.record_value).split(',');
  const result = [];
  for (let i = 0; i < types.length; i++) {
    const label = RECORD_TYPES[types[i].trim()];
    if (!label) continue;
    const rawVal = values[i] ? values[i].trim() : '';
    const numVal = parseFloat(rawVal);
    const display = isNaN(numVal) ? rawVal : (numVal % 1 === 0 ? String(Math.round(numVal)) : String(numVal));
    result.push({ label, value: display });
  }
  return result;
}

function renderSet(set, unit, setNum) {
  const parts = [];
  if (set.weight && parseFloat(set.weight) > 0) parts.push('<b>' + esc(fmtWeight(set.weight, unit)) + '</b>');
  if (set.reps) parts.push(esc(set.reps) + ' reps');
  if (set.duration) parts.push(esc(set.duration));
  if (set.distance) parts.push(esc(set.distance));

  const records = parseRecords(set);
  let recHtml = '';
  if (records.length) {
    recHtml = ' ' + records.map((r) => '<span class="record-badge" title="' + esc(r.label) + ' PR">🏆 ' + esc(r.label) + ': ' + esc(r.value) + '</span>').join(' ');
  }

  return '<div class="set-row"><span class="set-num">#' + setNum + '</span> ' + parts.join(' · ') + recHtml + '</div>';
}

function renderExercise(ex, unit) {
  const typeInfo = EXERCISE_TYPES[ex.exercise_type] || { label: ex.exercise_type || '', color: '#6b7280' };
  const badgeHtml = typeInfo.label ? '<span class="type-badge" style="background:' + typeInfo.color + '">' + esc(typeInfo.label) + '</span>' : '';
  const noteHtml = ex.exercise_note ? '<div class="ex-note">📝 ' + esc(decodeUnicode(ex.exercise_note)) + '</div>' : '';
  const setsHtml = (ex.sets || []).map((s, i) => renderSet(s, unit, i + 1)).join('');
  return '<div class="exercise">'
    + '<div class="ex-header"><span class="ex-name">' + esc(decodeUnicode(ex.excercise_name || 'Exercise')) + '</span>' + badgeHtml + '</div>'
    + noteHtml
    + '<div class="sets">' + setsHtml + '</div>'
    + '</div>';
}

function countSets(workout) {
  let n = 0;
  for (const ex of (workout.exercises || [])) n += (ex.sets || []).length;
  return n;
}

function renderSharePage(workout, opts) {
  const unit = opts.unit || 'kg';
  const w = workout;
  const title = cleanTitle(w.title);
  const dateStr = fmtDate(w.workout_perform_date || w.create_date);
  const volume = fmtVolume(w.total_volume || w.totalLiftedWeight || 0, unit);
  const duration = w.workout_duration || '—';
  const sets = countSets(w);
  const exercises = (w.exercises || []).length;

  let durDisplay = duration;
  const parts = String(duration).split(':');
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    if (h === 0) durDisplay = parts.slice(1).join(':');
    else durDisplay = h + ':' + parts[1] + ':' + parts[2];
  }

  const cardImg = w.card_path ? '/share/' + w.id + '/card.jpg' : '';
  const exercisesHtml = (w.exercises || []).map((ex) => renderExercise(ex, unit)).join('');

  const first = w.user_first || '';
  const last = w.user_last || '';
  const userName = (first || last) ? (first + ' ' + last).trim() : '';

  return '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">'
    + '<meta property="og:title" content="' + esc(title) + '">'
    + '<meta property="og:description" content="' + esc(volume) + ' · ' + esc(durDisplay) + ' · ' + sets + ' sets">'
    + (cardImg ? '<meta property="og:image" content="' + esc(cardImg) + '">' : '')
    + '<title>' + esc(title) + ' · OpenLyfta</title>'
    + '<style>'
    + ':root{--bg:#0f1115;--card:#191c23;--card2:#1e222b;--line:#262a34;--muted:#8a8e9b;--acc:#EB445A;--t:#e9eaef}'
    + '*{box-sizing:border-box;margin:0;padding:0}'
    + 'body{font-family:"Google Sans",system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--t);min-height:100vh}'
    + '.container{max-width:560px;margin:0 auto;padding:1rem}'
    + '.card-wrap{width:100%;border-radius:14px;overflow:hidden;margin-bottom:1.2rem;background:var(--card)}'
    + '.card-wrap img{width:100%;display:block}'
    + '.header{text-align:center;margin-bottom:1.5rem}'
    + '.header h1{font-size:1.5rem;font-weight:700;margin-bottom:.3rem}'
    + '.header .date{color:var(--muted);font-size:.9rem}'
    + '.stats-bar{display:flex;justify-content:space-around;background:var(--card);border-radius:14px;padding:1.2rem;margin-bottom:1.5rem}'
    + '.stat-item{text-align:center}'
    + '.stat-item .v{font-size:1.3rem;font-weight:700;color:var(--t)}'
    + '.stat-item .l{font-size:.75rem;color:var(--muted);margin-top:.2rem;text-transform:uppercase;letter-spacing:.5px}'
    + '.section-title{font-size:.8rem;color:var(--muted);text-transform:uppercase;letter-spacing:1px;margin-bottom:.8rem;padding-left:.3rem}'
    + '.exercise{background:var(--card);border-radius:12px;padding:1rem;margin-bottom:.7rem;border:1px solid var(--line)}'
    + '.ex-header{display:flex;align-items:center;justify-content:space-between;gap:.6rem;flex-wrap:wrap;margin-bottom:.5rem}'
    + '.ex-name{font-weight:600;font-size:1rem}'
    + '.type-badge{font-size:.7rem;color:#fff;padding:.2rem .6rem;border-radius:99px;font-weight:600;white-space:nowrap}'
    + '.ex-note{font-size:.8rem;color:var(--muted);margin-bottom:.5rem;font-style:italic;padding:.4rem .6rem;background:rgba(255,255,255,.04);border-radius:8px}'
    + '.sets{display:flex;flex-direction:column;gap:.35rem}'
    + '.set-row{font-size:.9rem;color:#c0c4ce;padding:.2rem 0 .2rem .8rem;border-left:2px solid var(--line)}'
    + '.set-num{color:var(--muted);font-weight:600;font-size:.78rem;min-width:24px;display:inline-block}'
    + '.record-badge{font-size:.72rem;color:#fbbf24;background:rgba(251,191,36,.1);padding:.15rem .5rem;border-radius:6px;font-weight:500;margin-left:.3rem;white-space:nowrap}'
    + '.footer{text-align:center;padding:2rem 0 1rem;color:var(--muted);font-size:.8rem}'
    + '.footer a{color:#3b82f6;text-decoration:none}'
    + '</style>'
    + '<div class="container">'
    + (cardImg ? '<div class="card-wrap"><img src="' + esc(cardImg) + '" alt="' + esc(title) + '"></div>' : '')
    + '<div class="header">'
    + '<h1>' + esc(title) + '</h1>'
    + '<div class="date">' + esc(dateStr) + (userName ? ' · ' + esc(userName) : '') + '</div>'
    + '</div>'
    + '<div class="stats-bar">'
    + '<div class="stat-item"><div class="v">' + esc(volume) + '</div><div class="l">Weight Lifted</div></div>'
    + '<div class="stat-item"><div class="v">' + esc(durDisplay) + '</div><div class="l">Duration</div></div>'
    + '<div class="stat-item"><div class="v">' + sets + '</div><div class="l">Total Sets</div></div>'
    + '<div class="stat-item"><div class="v">' + exercises + '</div><div class="l">Exercises</div></div>'
    + '</div>'
    + '<div class="section-title">Exercises</div>'
    + exercisesHtml
    + '<div class="footer">Powered by <a href="/">OpenLyfta</a></div>'
    + '</div>';
}

module.exports = { renderSharePage };
