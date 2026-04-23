const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');
const { getDb } = require('../database');
const { indexFile, computePhash, hammingDistance } = require('./mediaIndexer');
const { analyzePhoto, saveAnalysis } = require('./photoAnalyzer');
const { analyzeVideo, saveVideoAnalysis } = require('./videoAnalyzer');

function computeMd5(filepath) {
  const data = fs.readFileSync(filepath);
  return crypto.createHash('md5').update(data).digest('hex');
}

const TOKENS_PATH = path.resolve(process.env.DB_PATH || './data/videoforge.db', '..', 'tokens.json');
const TEMP_DIR = path.resolve(process.env.TEMP_DIR || './temp');
const IMAGE_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/bmp',
  'image/avif', 'image/heif', 'image/heic',
];
const VIDEO_MIMES = [
  'video/mp4', 'video/quicktime', 'video/x-msvideo', 'video/x-matroska',
  'video/webm', 'video/mpeg', 'video/3gpp',
];
const MEDIA_MIMES = [...IMAGE_MIMES, ...VIDEO_MIMES];

function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl() {
  const client = createOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/drive.readonly'],
  });
}

async function getTokensFromCode(code) {
  const client = createOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

function saveTokens(tokens) {
  const dir = path.dirname(TOKENS_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2));
  console.log('Tokens saved to', TOKENS_PATH);
}

function loadTokens() {
  if (!fs.existsSync(TOKENS_PATH)) return null;
  return JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf-8'));
}

function getAuthedClient(tokens) {
  const client = createOAuth2Client();
  client.setCredentials(tokens);

  // Auto-save refreshed tokens
  client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    saveTokens(merged);
    console.log('Tokens auto-refreshed and saved');
  });

  return client;
}

async function listMediaInFolder(auth, folderId) {
  const drive = google.drive({ version: 'v3', auth });

  const files = [];

  // Get all items in this folder (photos + subfolders)
  let pageToken = null;
  do {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: 100,
      pageToken,
    });

    for (const f of res.data.files) {
      if (f.mimeType === 'application/vnd.google-apps.folder') {
        // Recurse into subfolders
        console.log(`  Entering subfolder: ${f.name}`);
        const subFiles = await listMediaInFolder(auth, f.id);
        files.push(...subFiles);
      } else if (MEDIA_MIMES.includes(f.mimeType)) {
        files.push(f);
      }
    }

    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function downloadFile(auth, fileId, filename) {
  const drive = google.drive({ version: 'v3', auth });

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

  const destPath = path.join(TEMP_DIR, `${fileId}_${filename}`);
  const dest = fs.createWriteStream(destPath);

  const res = await drive.files.get(
    { fileId, alt: 'media' },
    { responseType: 'stream' }
  );

  await new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });

  return destPath;
}

async function syncFolder(auth, folderId, thumbnailDir) {
  const db = getDb();
  const files = await listMediaInFolder(auth, folderId);

  const results = { synced: 0, analyzed: 0, skipped: 0, duplicates: 0, errors: 0, total: files.length };

  for (const file of files) {
    // Level 0: skip if already synced by drive_file_id
    const existing = db.prepare('SELECT id FROM media WHERE drive_file_id = ?').get(file.id);
    if (existing) {
      results.skipped++;
      console.log(`  Skipped (already synced): ${file.name}`);
      continue;
    }

    // Level 1: skip if filename already exists in DB
    const byName = db.prepare('SELECT id FROM media WHERE filename = ?').get(file.name);
    if (byName) {
      results.duplicates++;
      console.log(`  Пропущен дубль (имя файла): ${file.name}`);
      continue;
    }

    let tempPath;
    try {
      // 1. Download to temp/
      console.log(`  Downloading: ${file.name}`);
      tempPath = await downloadFile(auth, file.id, file.name);

      // Level 2: skip if MD5 hash already exists in DB
      const md5 = computeMd5(tempPath);
      const byHash = db.prepare('SELECT id, filename FROM media WHERE md5_hash = ?').get(md5);
      if (byHash) {
        results.duplicates++;
        console.log(`  Пропущен дубль (MD5): ${file.name} совпадает с ${byHash.filename}`);
        continue;
      }

      // Level 3: perceptual hash — detect visually similar images
      const isImage = IMAGE_MIMES.includes(file.mimeType);
      if (isImage) {
        let phashDuplicate = false;
        try {
          const phash = await computePhash(tempPath);
          const allHashes = db.prepare('SELECT id, filename, phash FROM media WHERE phash IS NOT NULL').all();
          for (const row of allHashes) {
            const dist = hammingDistance(phash, row.phash);
            if (dist < 10) {
              results.duplicates++;
              console.log(`  Пропущен дубль (pHash, расстояние=${dist}): ${file.name} визуально совпадает с ${row.filename}`);
              phashDuplicate = true;
              break;
            }
          }
        } catch (err) {
          console.warn(`  pHash check failed for ${file.name}: ${err.message}`);
        }
        if (phashDuplicate) continue;
      }

      // 2. Index: extract metadata + generate thumbnail
      const mediaId = await indexFile(tempPath, thumbnailDir);

      if (mediaId) {
        // Mark as Drive-sourced
        db.prepare(
          "UPDATE media SET drive_file_id = ?, filepath = ? WHERE id = ?"
        ).run(file.id, `gdrive://${file.id}`, mediaId);
        results.synced++;
        console.log(`  Synced: ${file.name}`);

        // 3. Analyze with Claude Vision (before deleting temp file)
        const isVideo = VIDEO_MIMES.includes(file.mimeType);
        try {
          if (isVideo) {
            const analysis = await analyzeVideo(tempPath, file.name);
            saveVideoAnalysis(mediaId, analysis);
            results.analyzed++;
            console.log(`    Video analysis saved: ${analysis.frames_analyzed} frames, ${analysis.tags_ru?.length || 0} RU tags`);
          } else {
            const analysis = await analyzePhoto(tempPath, file.name);
            saveAnalysis(mediaId, analysis);
            results.analyzed++;
            console.log(`    Analysis saved: ${analysis.tags_ru?.length || 0} RU tags, ${analysis.tags_en?.length || 0} EN tags`);
          }
        } catch (err) {
          console.error(`    Analysis failed for ${file.name}:`, err.message);
        }
      } else {
        results.skipped++;
      }
    } catch (err) {
      results.errors++;
      console.error(`  Error syncing ${file.name}:`, err.message);
    } finally {
      // 4. Always clean up temp file
      if (tempPath && fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }

  return results;
}

module.exports = {
  createOAuth2Client,
  getAuthUrl,
  getTokensFromCode,
  getAuthedClient,
  saveTokens,
  loadTokens,
  syncFolder,
};
