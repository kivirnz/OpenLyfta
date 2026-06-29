'use strict';
const fs = require('node:fs');
const path = require('node:path');
const sharp = require('sharp');
const { muscleById } = require('./muscles');

const LOGO_PATH = path.join(__dirname, '..', '..', 'assets', 'img', 'transparent.png');

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

  // Body figures: 18% -> 30% bigger = ~23.4% of image height
  const targetBodyHeight = Math.round(PH * 0.234);
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

  // Stats: vertical stack above the body model — label then value, centred, with gaps between groups
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

  // Label font 30% bigger (26 -> 34), numeric font 20% bigger (26 -> 31)
  const labelFS = 34;
  const numFS = 31;
  const labelLineH = 42;
  const numLineH = 38;
  const groupGap = 14;

  // Center of the body block (for text centering and logo placement)
  const bodyBlockW = frontSm ? (frontSm.width * 2 + 12) : 0;
  const bodyCenterX = bodyLeft + bodyBlockW / 2;

  const groups = [
    { label: 'Weight Lifted', value: volume },
    { label: 'Duration', value: duration },
    { label: 'Total Sets', value: String(sets) },
  ];

  let totalH = 0;
  const groupLayouts = groups.map((g) => {
    const h = labelLineH + numLineH;
    const layout = { ...g, startY: totalH, labelY: totalH + labelLineH - 6, valueY: totalH + labelLineH + numLineH - 6 };
    totalH += h + groupGap;
    return layout;
  });
  totalH -= groupGap;

  const statsSvg = Buffer.from(`
    <svg xmlns="http://www.w3.org/2000/svg" width="${PW}" height="${totalH}">
      ${groupLayouts.map((g) => `
      <text x="${bodyCenterX}" y="${g.labelY}" text-anchor="middle" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="${labelFS}" fill="#ffffff" font-weight="700">${esc(g.label)}</text>
      <text x="${bodyCenterX}" y="${g.valueY}" text-anchor="middle" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="${numFS}" fill="#ffffff" font-weight="700">${esc(g.value)}</text>`).join('\n')}
    </svg>`);

  const statsTop = bodyTop - totalH + 4;

  const comps = [
    { input: picturePath, blend: 'over' },
  ];
  if (frontScaled && backScaled) {
    comps.push({ input: frontScaled, blend: 'over', left: bodyLeft, top: bodyTop });
    comps.push({ input: backScaled, blend: 'over', left: bodyLeft + frontSm.width + 12, top: bodyTop });
  } else if (frontScaled) {
    comps.push({ input: frontScaled, blend: 'over', left: bodyLeft, top: bodyTop });
  }
  // OpenLyfta logo centered between the two body models, at the very bottom
  if (fs.existsSync(LOGO_PATH)) {
    const logoMeta = await sharp(LOGO_PATH).metadata();
    const logoMaxW = 200;
    const logoScale = Math.min(1, logoMaxW / logoMeta.width);
    const logoW = Math.round(logoMeta.width * logoScale);
    const logoH = Math.round(logoMeta.height * logoScale);
    const logo = await sharp(LOGO_PATH).resize(logoW, logoH, { fit: 'inside' }).png().toBuffer();
    const logoLeft = Math.round(bodyCenterX - logoW / 2);
    comps.push({ input: logo, blend: 'over', left: Math.max(0, logoLeft), top: PH - logoH - 12 });
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

// Generate 3x3 exercise collage card(s) for workouts without a picture.
// Returns array of output paths (one per 9 exercises).
// exerciseImages: array of { buf, name, sets }
async function generateCollage(workout, { exerciseImages, outPath, logger = console } = {}) {
  const PW = 1080;
  const cols = 3, rows = 3;
  const padding = 24;
  const gap = 12;
  const logoH = 80;
  const gridH = 1434;
  const PH = gridH + logoH;
  const cellW = Math.floor((PW - padding * 2 - gap * (cols - 1)) / cols);
  const cellH = Math.floor((gridH - padding * 2 - gap * (rows - 1)) / rows);
  const imgH = Math.round(cellH * 0.74);
  const textH = cellH - imgH;

  const perPage = cols * rows;
  const pages = [];
  for (let i = 0; i < exerciseImages.length; i += perPage) {
    pages.push(exerciseImages.slice(i, i + perPage));
  }

  const outPaths = [];
  for (let p = 0; p < pages.length; p++) {
    const items = pages[p];
    const comps = [];

    for (let i = 0; i < items.length; i++) {
      const row = Math.floor(i / cols);
      const col = i % cols;
      const x = padding + col * (cellW + gap);
      const y = padding + row * (cellH + gap);

      const item = items[i];
      let imgBuf;
      try {
        imgBuf = await sharp(item.buf)
          .resize({ width: cellW, height: imgH, fit: 'cover', position: 'center' })
          .png().toBuffer();
      } catch { continue; }
      comps.push({ input: imgBuf, blend: 'over', left: x, top: y });

      let label = `${item.sets} × ${item.name}`;
      const maxChars = Math.floor(cellW / 11);
      if (label.length > maxChars) label = label.slice(0, maxChars - 1) + '…';
      const fontSize = Math.min(22, Math.max(16, Math.floor(cellW / label.length * 1.8)));
      const textSvg = Buffer.from(`
        <svg xmlns="http://www.w3.org/2000/svg" width="${cellW}" height="${textH}">
          <text x="${cellW / 2}" y="${textH / 2 + fontSize / 3}" text-anchor="middle" font-family="Google Sans, DejaVu Sans, sans-serif" font-size="${fontSize}" fill="#ffffff" font-weight="600">${esc(label)}</text>
        </svg>`);
      comps.push({ input: textSvg, blend: 'over', left: x, top: y + imgH });
    }

    if (fs.existsSync(LOGO_PATH)) {
      const logoMeta = await sharp(LOGO_PATH).metadata();
      const targetH = 96;
      const scale = targetH / logoMeta.height;
      const logoW = Math.round(logoMeta.width * scale);
      const logo = await sharp(LOGO_PATH).resize(logoW, targetH, { fit: 'inside' }).png().toBuffer();
      comps.push({ input: logo, blend: 'over', left: 24, top: gridH + (logoH - targetH) / 2 - 8 });
    }

    const pagePath = pages.length > 1 ? outPath.replace(/\.jpg$/, `_${p + 1}.jpg`) : outPath;
    const out = await sharp({ create: { width: PW, height: PH, channels: 4, background: { r: 17, g: 19, b: 23, alpha: 1 } } })
      .composite(comps)
      .jpeg({ quality: 92 }).toBuffer();

    fs.mkdirSync(path.dirname(pagePath), { recursive: true });
    fs.writeFileSync(pagePath, out);
    outPaths.push(pagePath);
    logger.log(`[collage] wrote ${pagePath} (${PW}x${PH})`);
  }

  return outPaths;
}

module.exports = { generateCard, generateCollage, hexToRgb, fmtVolume };