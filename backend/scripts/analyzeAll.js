require('dotenv').config({ path: './config/.env' });

const path = require('path');
const { initDatabase, getDb } = require('../src/database');
const { analyzePhoto, saveAnalysis } = require('../src/services/photoAnalyzer');

async function main() {
  initDatabase();
  const db = getDb();

  const rows = db.prepare(`
    SELECT m.id, m.filename, m.thumbnail
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.thumbnail IS NOT NULL AND ma.media_id IS NULL
  `).all();

  console.log(`Found ${rows.length} unanalyzed photos\n`);

  let ok = 0, fail = 0;

  for (let i = 0; i < rows.length; i++) {
    const media = rows[i];
    const thumbPath = path.resolve(process.env.THUMBNAILS_DIR || './thumbnails', media.thumbnail);
    console.log(`[${i + 1}/${rows.length}] ${media.filename}`);

    try {
      const analysis = await analyzePhoto(thumbPath, media.filename);
      saveAnalysis(media.id, analysis);
      console.log(`  => ${analysis.year_estimate || '?'} | ${analysis.historical_period || '?'} | ${(analysis.tags_ru || []).length} tags`);
      ok++;
    } catch (err) {
      console.error(`  => ERROR: ${err.message}`);
      fail++;
    }
  }

  console.log(`\nDone: ${ok} analyzed, ${fail} failed`);
}

main().catch(err => console.error('Fatal:', err.message));
