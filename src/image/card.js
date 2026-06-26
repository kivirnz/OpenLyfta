'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { muscleById } = require('./muscles');

const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'img', 'stickfigure.png');

const BODY_DIR = path.join(__dirname, '..', '..', 'assets', 'bodymaps');
function basePaths(gender) {
  const g = gender === 'female' ? 'female' : 'male';
  const front = path.join(BODY_DIR, g, g === 'female' ? 'front_grey_body_female.webp' : 'front_grey_body.webp');
  let back = path.join(BODY_DIR, g, g === 'female' ? 'back_gray_body_female.webp' : 'back_grey_body.webp');
  if (!fs.existsSync(back)) back = path.join(BODY_DIR, g, 'back_grey_body.webp');
  return { front, back };
}

function hexToRgb(h) {
  const m = String(h || '#EB445A').replace('#', '').match(/^([0-9a-f]{6})$/i);
  if (!m) return { r: 235, g: 68, b: 90 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function mix(rgb, f = 0.5) {
  return { r: Math.round(rgb.r * f + 128 * (1 - f)), g: Math.round(rgb.g * f + 128 * (1 - f)), b: Math.round(rgb.b * f + 128 * (1 - f)) };
}

const _silhouetteCache = new Map();
async function tintedSilhouette(file, rgb, gender) {
  const key = `${gender}|${file}|${rgb.r},${rgb.g},${rgb.b}`;
  if (_silhouetteCache.has(key)) return _silhouetteCache.get(key);
  // Try gender folder first, fall back to the other gender's asset (Lyfta reuses some).
  const g = gender === 'female' ? ['female', 'male'] : ['male', 'female'];
  let musclePath = null;
  for (const sub of g) {
    const p = path.join(BODY_DIR, sub, `${file}.webp`);
    if (fs.existsSync(p)) { musclePath = p; break; }
  }
  if (!musclePath) return null;
  const meta = await sharp(musclePath).metadata();
  const W = meta.width, H = meta.height;
  const color = sharp({ create: { width: W, height: H, channels: 4, background: { r: rgb.r, g: rgb.g, b: rgb.b, alpha: 255 } } });
  const masked = color.composite([{ input: musclePath, blend: 'dest-in' }]);
  const buf = await masked.png({ compressionLevel: 6 }).toBuffer();
  _silhouetteCache.set(key, buf);
  return buf;
}

async function buildBodyFigure({ primaryIds, secondaryIds, primary, secondaryLight, gender }) {
  const { front: FRONT_BASE, back: BACK_BASE } = basePaths(gender);
  const frontBase = await sharp(FRONT_BASE).metadata();
  const W = frontBase.width, H = frontBase.height;

  const paint = (ids, color, wantFront) => {
    const out = [];
    for (const id of ids) {
      const drawables = muscleById(id, gender) || [];
      for (const d of drawables) {
        if (Boolean(d.front) === wantFront) out.push({ file: d.file, color });
      }
    }
    // Dedupe by file (Lyfta sometimes lists the same asset twice)
    const seen = new Set(); const dd = [];
    for (const x of out) { if (!seen.has(x.file)) { seen.add(x.file); dd.push(x); } }
    return dd;
  };

  const composeFront = [{ input: FRONT_BASE, blend: 'over' }];
  for (const { file, color } of paint(primaryIds, primary, true)) {
    const buf = await tintedSilhouette(file, color, gender);
    if (buf) composeFront.push({ input: buf, blend: 'over' });
  }
  for (const { file, color } of paint(secondaryIds, secondaryLight, true)) {
    const buf = await tintedSilhouette(file, color, gender);
    if (buf) composeFront.push({ input: buf, blend: 'over' });
  }
  const frontPng = await sharp({ create: { width: W, height: H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composeFront).png().toBuffer();

  const backMeta = await sharp(BACK_BASE).metadata();
  const BW = backMeta.width, BH = backMeta.height;
  const composeBack = [{ input: BACK_BASE, blend: 'over' }];
  for (const { file, color } of paint(primaryIds, primary, false)) {
    const buf = await tintedSilhouette(file, color, gender);
    if (buf) composeBack.push({ input: buf, blend: 'over' });
  }
  for (const { file, color } of paint(secondaryIds, secondaryLight, false)) {
    const buf = await tintedSilhouette(file, color, gender);
    if (buf) composeBack.push({ input: buf, blend: 'over' });
  }
  const backPng = await sharp({ create: { width: BW, height: BH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composeBack).png().toBuffer();

  return { frontPng, backPng, W, H, BW, BH };
}

function fmtVolume(v) {
  const n = +v || 0;
  if (n >= 1000) return `${(n / 1000).toFixed(2)}t`;
  return `${Math.round(n)}kg`;
}

function countSets(workout) {
  let n = 0;
  for (const ex of (workout.exercises || [])) n += (ex.sets || []).length;
  return n;
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function validGender(g) {
  const v = String(g || '').toLowerCase();
  return v === 'male' || v === 'female' ? v : null;
}

// Build the full share card. Returns path to JPEG written to outPath.
async function generateCard(workout, { primaryMuscleIds = [], secondaryMuscleIds = [], outPath, gender = null, logger = console } = {}) {
  const picturePath = workout.picture_path || workout.picturePath;
  if (!picturePath || !fs.existsSync(picturePath)) throw new Error(`workout ${workout.id} has no local picture`);
  const pic = await sharp(picturePath).metadata();
  const PW = pic.width, PH = pic.height;

  const primary = hexToRgb(workout.color);
  const secondaryLight = mix(primary, 0.45);
  const g = validGender(gender);

  // Body figures: only build if we have a valid gender
  const targetBodyHeight = Math.round(PH * 0.30);
  const bodyLeft = 36;
  const bodyTop = PH - targetBodyHeight - 80;

  let frontScaled = null, backScaled = null, frontSm = null, backSm = null, blockW = 0;

  if (g) {
    const { frontPng, backPng } = await buildBodyFigure({ primaryIds: primaryMuscleIds, secondaryIds: secondaryMuscleIds, primary, secondaryLight, gender: g });
    frontScaled = await sharp(frontPng).resize({ height: targetBodyHeight, fit: 'inside' }).png().toBuffer();
    backScaled = await sharp(backPng).resize({ height: targetBodyHeight, fit: 'inside' }).png().toBuffer();
    frontSm = await sharp(frontScaled).metadata();
    backSm = await sharp(backScaled).metadata();
    const gap = 16;
    blockW = frontSm.width + backSm.width + gap;
  }

  // Stats box to the right of the body figures (or left-aligned if no body maps)
  const sets = countSets(workout);
  const volume = fmtVolume(workout.total_volume || workout.totalLiftedWeight || 0);
  const duration = (workout.workout_duration || '00:00:00');

  // white rounded panel behind stats
  const panelPad = 26;
  const lineH = 52, labelFS = 26, valueFS = 38;
  const rows = [
    { label: 'Weight Lifted', value: volume },
    { label: 'Duration', value: duration },
    { label: 'Total Sets', value: `${sets}` },
  ];
  const panelW = Math.max(...rows.map((r) => r.label.length * 13 + r.value.length * 23)) + panelPad * 2 + 16;
  const panelH = rows.length * lineH + panelPad * 2;
  const panelLeft = bodyLeft + blockW + (blockW ? 40 : 0);
  const panelTop = bodyTop + (targetBodyHeight - panelH) / 2;

  const rowsSvg = rows.map((r, i) => {
    const y = panelPad + i * lineH;
    return `
      <text x="${panelPad}" y="${y + labelFS}" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="${labelFS}" fill="rgba(255,255,255,0.75)" font-weight="500">${esc(r.label)}</text>
      <text x="${panelPad}" y="${y + labelFS + valueFS}" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="${valueFS}" fill="#ffffff" font-weight="700">${esc(r.value)}</text>`;
  }).join('\n');

  const panelSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${panelW}" height="${panelH}">
      <rect x="0" y="0" width="${panelW}" height="${panelH}" rx="22" ry="22" fill="rgba(20,22,28,0.72)"/>
      ${rowsSvg}
    </svg>`);

  // Title chip near top-left of the body block
  const title = workout.title || 'Workout';
  const titleSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="120">
      <text x="${bodyLeft}" y="60" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="44" fill="#ffffff" font-weight="700">${esc(title)}</text>
    </svg>`);

  // Lyfta-style workout number / date pill near title
  const dateStr = (workout.workout_perform_date || workout.create_date || '').slice(0, 16).replace('T', ' ');
  const pillW = Math.max(180, dateStr.length * 12 + 40);
  const datePillSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${pillW}" height="46">
      <rect x="0" y="0" width="${pillW}" height="46" rx="23" ry="23" fill="rgba(${primary.r},${primary.g},${primary.b},0.9)"/>
      <text x="${pillW / 2}" y="31" text-anchor="middle" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="22" fill="#ffffff" font-weight="600">${esc(dateStr)}</text>
    </svg>`);

  const comps = [
    { input: picturePath, blend: 'over' },
    // dark scrim behind body+panel region for contrast
    { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${PH}"><rect x="0" y="${bodyTop - 40}" width="${PW}" height="${PH - (bodyTop - 40)}" fill="rgba(0,0,0,0.42)"/></svg>`), blend: 'over' },
  ];
  // OpenLyfta stickfigure logo watermark (top-right corner)
  if (fs.existsSync(LOGO_PATH)) {
    const logoSize = 56;
    const logo = await sharp(LOGO_PATH).resize(logoSize, logoSize, { fit: 'inside' }).png().toBuffer();
    comps.push({ input: logo, blend: 'over', left: PW - logoSize - 24, top: 24 });
  }
  if (frontScaled && backScaled) {
    comps.push({ input: frontScaled, blend: 'over', left: bodyLeft, top: bodyTop });
    comps.push({ input: backScaled, blend: 'over', left: bodyLeft + frontSm.width + 16, top: bodyTop });
  }
  comps.push(
    { input: panelSvg, blend: 'over', left: panelLeft, top: panelTop },
    { input: datePillSvg, blend: 'over', left: PW - pillW - 36, top: bodyTop - 70 },
    { input: titleSvg, blend: 'over', left: 0, top: bodyTop - 110 },
  );

  const out = await sharp({ create: { width: PW, height: PH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(comps)
    .jpeg({ quality: 92 }).toBuffer();

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, out);
  logger.log(`[card] wrote ${outPath} (${PW}x${PH})`);
  return outPath;
}

module.exports = { generateCard, hexToRgb, fmtVolume };