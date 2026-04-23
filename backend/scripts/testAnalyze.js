require('dotenv').config({ path: './config/.env' });

const { initDatabase, getDb } = require('../src/database');
const { analyzePhoto, saveAnalysis } = require('../src/services/photoAnalyzer');
const path = require('path');

async function main() {
  initDatabase();
  const db = getDb();

  // Pick first media with a thumbnail but no analysis
  const media = db.prepare(`
    SELECT m.id, m.filename, m.thumbnail
    FROM media m
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE m.thumbnail IS NOT NULL AND ma.media_id IS NULL
    LIMIT 1
  `).get();

  if (!media) { console.log('No unanalyzed media found'); return; }

  const thumbPath = path.resolve(process.env.THUMBNAILS_DIR || './thumbnails', media.thumbnail);
  console.log(`Testing analysis on: ${media.filename} (${thumbPath})\n`);

  const analysis = await analyzePhoto(thumbPath, media.filename);
  saveAnalysis(media.id, analysis);

  console.log('\n=== Result ===');
  console.log(`Description (RU): ${analysis.description_ru}`);
  console.log(`Year: ${analysis.year_estimate}`);
  console.log(`Period: ${analysis.historical_period}`);
  console.log(`Shot type: ${analysis.shot_type}`);
  console.log(`Tags RU: ${(analysis.tags_ru || []).join(', ')}`);
  console.log(`Tags EN: ${(analysis.tags_en || []).join(', ')}`);
  console.log(`Persons: ${JSON.stringify(analysis.persons)}`);
}

main().catch(err => console.error('Error:', err.message));
