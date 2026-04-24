require('dotenv').config({ path: './config/.env' });

const path = require('path');
const { initDatabase, getDb } = require('../src/database');
const { analyzePhoto, saveAnalysis } = require('../src/services/photoAnalyzer');

async function main() {
  initDatabase();
  const db = getDb();

  const thumbDir = path.resolve(process.env.THUMBNAILS_DIR || './thumbnails');
  const skipExisting = process.argv.includes('--skip-existing');
  const skipN = process.argv.find(a => a.startsWith('--skip='));
  const skipCount = skipN ? parseInt(skipN.split('=')[1]) : 0;

  let sql = `
    SELECT m.id, m.filename, m.thumbnail
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.thumbnail IS NOT NULL
  `;

  if (skipExisting) {
    sql += ` AND (ma.emotion IS NULL OR ma.media_id IS NULL)`;
  }

  sql += ` ORDER BY m.created_at`;

  let rows = db.prepare(sql).all();

  if (skipCount > 0) {
    rows = rows.slice(skipCount);
  }

  console.log(`Re-analyzing ${rows.length} photos${skipExisting ? ' (skipping existing)' : ''}${skipCount ? ` (skipped first ${skipCount})` : ''}\n`);

  let ok = 0, fail = 0;

  for (let i = 0; i < rows.length; i++) {
    const media = rows[i];
    const thumbPath = path.join(thumbDir, media.thumbnail);
    const name = media.filename.replace(/^[A-Za-z0-9_-]{20,}_/, '');
    console.log(`[${i + 1}/${rows.length}] ${name}`);

    try {
      const analysis = await analyzePhoto(thumbPath, media.filename);
      saveAnalysis(media.id, analysis);

      const fields = [
        analysis.emotion || '?',
        `${analysis.persons_count || '?'} persons`,
        analysis.photo_mood || '?',
        analysis.is_memorial ? 'MEMORIAL' : '',
      ].filter(Boolean).join(' | ');

      console.log(`  => ${fields}`);
      ok++;
    } catch (err) {
      console.error(`  => ERROR: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} re-analyzed, ${fail} failed`);
}

main().catch(err => console.error('Fatal:', err.message));
