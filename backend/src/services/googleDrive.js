const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { getDb } = require('../database');
const { indexFile } = require('./mediaIndexer');

const TEMP_DIR = path.resolve(process.env.TEMP_DIR || './temp');
const IMAGE_MIMES = [
  'image/jpeg', 'image/png', 'image/webp', 'image/tiff', 'image/bmp',
];

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

function getAuthedClient(tokens) {
  const client = createOAuth2Client();
  client.setCredentials(tokens);
  return client;
}

async function listPhotosInFolder(auth, folderId) {
  const drive = google.drive({ version: 'v3', auth });

  const mimeQuery = IMAGE_MIMES.map(m => `mimeType='${m}'`).join(' or ');
  const query = `'${folderId}' in parents and (${mimeQuery}) and trashed=false`;

  const files = [];
  let pageToken = null;

  do {
    const res = await drive.files.list({
      q: query,
      fields: 'nextPageToken, files(id, name, mimeType, size)',
      pageSize: 100,
      pageToken,
    });
    files.push(...res.data.files);
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
  const files = await listPhotosInFolder(auth, folderId);

  const results = { synced: 0, skipped: 0, errors: 0, total: files.length };

  for (const file of files) {
    // Skip if already synced
    const existing = db.prepare('SELECT id FROM media WHERE drive_file_id = ?').get(file.id);
    if (existing) {
      results.skipped++;
      console.log(`  Skipped (already synced): ${file.name}`);
      continue;
    }

    let tempPath;
    try {
      // Download to temp/
      console.log(`  Downloading: ${file.name}`);
      tempPath = await downloadFile(auth, file.id, file.name);

      // Index: extract metadata + generate thumbnail
      const mediaId = await indexFile(tempPath, thumbnailDir);

      if (mediaId) {
        // Mark as Drive-sourced and update filepath to virtual path
        db.prepare(
          "UPDATE media SET drive_file_id = ?, filepath = ? WHERE id = ?"
        ).run(file.id, `gdrive://${file.id}`, mediaId);
        results.synced++;
        console.log(`  Synced: ${file.name}`);
      } else {
        results.skipped++;
      }
    } catch (err) {
      results.errors++;
      console.error(`  Error syncing ${file.name}:`, err.message);
    } finally {
      // Always clean up temp file
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
  syncFolder,
};
