require('dotenv').config({ path: './config/.env' });
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { getDb } = require('../src/database');

const db = getDb();
const uploadsDir = path.resolve('./uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const projects = db.prepare("SELECT id, description, audio_path FROM projects WHERE audio_path IS NULL AND description LIKE 'Audio:%'").all();

console.log(`Found ${projects.length} projects without audio_path\n`);

for (const p of projects) {
  const match = p.description.match(/Audio:\s*(.+?),/);
  if (!match) continue;

  const filename = match[1].trim();
  console.log(`Project ${p.id}: looking for "${filename}"`);

  // Search on disk
  try {
    const result = execSync(`find /Users/formula/Desktop -maxdepth 5 -name "${filename}" 2>/dev/null`, { encoding: 'utf-8' }).trim();
    const paths = result.split('\n').filter(Boolean);

    if (paths.length > 0) {
      const src = paths[0];
      const dest = path.join(uploadsDir, filename);

      if (!fs.existsSync(dest)) {
        fs.copyFileSync(src, dest);
        console.log(`  Copied: ${src} → ${dest}`);
      }

      const absPath = path.resolve(dest);
      db.prepare('UPDATE projects SET audio_path = ? WHERE id = ?').run(absPath, p.id);
      console.log(`  Updated audio_path: ${absPath} (${(fs.statSync(absPath).size / 1024).toFixed(0)} KB)\n`);
    } else {
      console.log(`  NOT FOUND on disk\n`);
    }
  } catch (err) {
    console.log(`  Error: ${err.message}\n`);
  }
}

console.log('Done');
