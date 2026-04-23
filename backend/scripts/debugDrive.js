require('dotenv').config({ path: './config/.env' });

const { google } = require('googleapis');
const { loadTokens, getAuthedClient } = require('../src/services/googleDrive');

async function listAll(drive, folderId, depth = 0) {
  const prefix = '  '.repeat(depth);
  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, mimeType, size)',
    pageSize: 50,
  });

  if (res.data.files.length === 0) {
    console.log(`${prefix}(empty)`);
    return;
  }

  for (const f of res.data.files) {
    console.log(`${prefix}${f.name}  [${f.mimeType}]  ${f.size || '-'}`);
    if (f.mimeType === 'application/vnd.google-apps.folder') {
      await listAll(drive, f.id, depth + 1);
    }
  }
}

async function main() {
  const tokens = loadTokens();
  if (!tokens) { console.log('No tokens found'); process.exit(1); }

  const auth = getAuthedClient(tokens);
  const drive = google.drive({ version: 'v3', auth });
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID;

  console.log(`Recursive listing of folder: ${folderId}\n`);
  await listAll(drive, folderId, 0);
}

main().catch(err => console.error('Error:', err.message));
