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
  const n = Math.round(+v || 0);
  return n.toLocaleString('en-US') + 'kg';
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

  // Always use red for highlighted muscles
  const RED = { r: 235, g: 68, b: 90 };
  const RED_LIGHT = mix(RED, 0.50);
  const g = validGender(gender);

  // Body figures: 40% smaller than before (18% of image height instead of 30%)
  const targetBodyHeight = Math.round(PH * 0.18);
  const bodyLeft = 36;
  const bodyBottomMargin = 50;
  const bodyTop = PH - targetBodyHeight - bodyBottomMargin;

  let frontScaled = null, backScaled = null, frontSm = null;

  if (g) {
    const { frontPng, backPng } = await buildBodyFigure({ primaryIds: primaryMuscleIds, secondaryIds: secondaryMuscleIds, primary: RED, secondaryLight: RED_LIGHT, gender: g });
    frontScaled = await sharp(frontPng).resize({ height: targetBodyHeight, fit: 'inside' }).png().toBuffer();
    backScaled = await sharp(backPng).resize({ height: targetBodyHeight, fit: 'inside' }).png().toBuffer();
    frontSm = await sharp(frontScaled).metadata();
  }

  // Stats: compact horizontal row above the body model
  const sets = countSets(workout);
  const volume = fmtVolume(workout.total_volume || workout.totalLiftedWeight || 0);
  const durationRaw = (workout.workout_duration || '00:00:00');
  const parts = durationRaw.split(':');
  let duration = durationRaw;
  if (parts.length === 3) {
    const h = parseInt(parts[0], 10);
    if (h === 0) { duration = parts.slice(1).join(':'); }
    else { duration = h + ':' + parts[1] + ':' + parts[2]; }
  } else if (parts.length === 2) {
    const m = parseInt(parts[0], 10);
    duration = m + ':' + parts[1];
  }
  const statsH = 64;

  const statsSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${statsH}">
      <text x="${bodyLeft}" y="28" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="20" fill="rgba(255,255,255,0.65)" font-weight="500">Weight Lifted</text>
      <text x="${bodyLeft}" y="56" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="28" fill="#ffffff" font-weight="700">${esc(volume)}</text>
      <text x="${bodyLeft + 220}" y="28" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="20" fill="rgba(255,255,255,0.65)" font-weight="500">Duration</text>
      <text x="${bodyLeft + 220}" y="56" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="28" fill="#ffffff" font-weight="700">${esc(duration)}</text>
      <text x="${bodyLeft + 420}" y="28" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="20" fill="rgba(255,255,255,0.65)" font-weight="500">Total Sets</text>
      <text x="${bodyLeft + 420}" y="56" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="28" fill="#ffffff" font-weight="700">${esc(String(sets))}</text>
    </svg>`);

  const statsTop = bodyTop - statsH - 16;

  const comps = [
    { input: picturePath, blend: 'over' },
  ];
  // OpenLyfta stickfigure logo watermark (top-right corner)
  if (fs.existsSync(LOGO_PATH)) {
    const logoSize = 56;
    const logo = await sharp(LOGO_PATH).resize(logoSize, logoSize, { fit: 'inside' }).png().toBuffer();
    comps.push({ input: logo, blend: 'over', left: PW - logoSize - 24, top: 24 });
  }
  if (frontScaled && backScaled) {
    comps.push({ input: frontScaled, blend: 'over', left: bodyLeft, top: bodyTop });
    comps.push({ input: backScaled, blend: 'over', left: bodyLeft + frontSm.width + 12, top: bodyTop });
  }
  comps.push(
    { input: statsSvg, blend: 'over', left: 0, top: statsTop },
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