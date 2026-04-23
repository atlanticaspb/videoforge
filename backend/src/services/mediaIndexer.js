const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const ffmpeg = require('fluent-ffmpeg');
const sharp = require('sharp');
const { getDb } = require('../database');

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg');
ffmpeg.setFfprobePath(process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe');

function computeMd5(filepath) {
  const data = fs.readFileSync(filepath);
  return crypto.createHash('md5').update(data).digest('hex');
}

async function computePhash(filepath) {
  // Resize to 8x8 grayscale, get raw pixel data
  const { data } = await sharp(filepath)
    .resize(8, 8, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Compute average pixel value
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const avg = sum / data.length;

  // Build 64-bit hash: 1 if pixel >= average, 0 otherwise
  let hash = '';
  for (let i = 0; i < data.length; i++) {
    hash += data[i] >= avg ? '1' : '0';
  }
  return hash;
}

function hammingDistance(a, b) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) dist++;
  }
  return dist;
}

const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v']);
const AUDIO_EXTS = new Set(['.mp3', '.wav', '.aac', '.flac', '.ogg', '.m4a']);
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.tiff', '.bmp', '.avif', '.heif', '.heic']);

function getMediaType(ext) {
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (IMAGE_EXTS.has(ext)) return 'image';
  return null;
}

function probeFile(filepath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filepath, (err, metadata) => {
      if (err) return reject(err);
      resolve(metadata);
    });
  });
}

async function generateThumbnail(filepath, outputDir) {
  const thumbName = `${uuidv4()}.jpg`;
  const thumbPath = path.join(outputDir, thumbName);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const ext = path.extname(filepath).toLowerCase();

  if (IMAGE_EXTS.has(ext)) {
    await sharp(filepath).resize(320, 180, { fit: 'cover' }).jpeg({ quality: 80 }).toFile(thumbPath);
    return thumbName;
  }

  return new Promise((resolve, reject) => {
    ffmpeg(filepath)
      .screenshots({
        timestamps: ['10%'],
        filename: thumbName,
        folder: outputDir,
        size: '320x180',
      })
      .on('end', () => resolve(thumbName))
      .on('error', (err) => reject(err));
  });
}

async function indexFile(filepath, thumbnailDir) {
  const ext = path.extname(filepath).toLowerCase();
  const type = getMediaType(ext);
  if (!type) return null;

  const stat = fs.statSync(filepath);
  const db = getDb();

  const existing = db.prepare('SELECT id FROM media WHERE filepath = ?').get(filepath);
  if (existing) return existing.id;

  let duration = null;
  let width = null;
  let height = null;
  let fps = null;
  let codec = null;

  if (type === 'video' || type === 'audio') {
    try {
      const meta = await probeFile(filepath);
      const stream = meta.streams.find(s => s.codec_type === type) || meta.streams[0];
      duration = meta.format.duration || null;
      width = stream.width || null;
      height = stream.height || null;
      codec = stream.codec_name || null;
      if (stream.r_frame_rate) {
        const [num, den] = stream.r_frame_rate.split('/');
        fps = den ? Number(num) / Number(den) : Number(num);
      }
    } catch (err) {
      console.warn(`Could not probe ${filepath}:`, err.message);
    }
  } else if (type === 'image') {
    try {
      const meta = await sharp(filepath).metadata();
      width = meta.width;
      height = meta.height;
    } catch (err) {
      console.warn(`Could not read image metadata ${filepath}:`, err.message);
    }
  }

  let thumbnail = null;
  try {
    thumbnail = await generateThumbnail(filepath, thumbnailDir);
  } catch (err) {
    console.warn(`Could not generate thumbnail for ${filepath}:`, err.message);
  }

  const md5 = computeMd5(filepath);

  // Compute perceptual hash for images
  let phash = null;
  if (type === 'image') {
    try {
      phash = await computePhash(filepath);
    } catch (err) {
      console.warn(`Could not compute pHash for ${filepath}:`, err.message);
    }
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO media (id, filename, filepath, type, duration, width, height, fps, codec, size, thumbnail, md5_hash, phash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, path.basename(filepath), filepath, type, duration, width, height, fps, codec, stat.size, thumbnail, md5, phash);

  return id;
}

async function indexDirectory(dirPath, thumbnailDir) {
  const results = { indexed: 0, skipped: 0, errors: 0 };

  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      const sub = await indexDirectory(fullPath, thumbnailDir);
      results.indexed += sub.indexed;
      results.skipped += sub.skipped;
      results.errors += sub.errors;
      continue;
    }

    if (!entry.isFile()) continue;

    const type = getMediaType(path.extname(entry.name).toLowerCase());
    if (!type) {
      results.skipped++;
      continue;
    }

    try {
      await indexFile(fullPath, thumbnailDir);
      results.indexed++;
      console.log(`  Indexed: ${entry.name}`);
    } catch (err) {
      results.errors++;
      console.error(`  Error indexing ${entry.name}:`, err.message);
    }
  }

  return results;
}

module.exports = { indexFile, indexDirectory, getMediaType, computePhash, hammingDistance };
