require('dotenv').config({ path: './config/.env' });

const path = require('path');
const { initDatabase, getDb } = require('../src/database');
const { analyzePhoto, saveAnalysis } = require('../src/services/photoAnalyzer');

async function main() {
  initDatabase();
  const db = getDb();

  // Pick first media with a thumbnail
  const media = db.prepare(`
    SELECT m.id, m.filename, m.thumbnail
    FROM media m
    WHERE m.thumbnail IS NOT NULL
    LIMIT 1
  `).get();

  if (!media) { console.log('No media found'); return; }

  const thumbPath = path.resolve(process.env.THUMBNAILS_DIR || './thumbnails', media.thumbnail);
  console.log(`Re-analyzing: ${media.filename}\n`);

  const analysis = await analyzePhoto(thumbPath, media.filename);
  saveAnalysis(media.id, analysis);

  console.log('=== Result ===');
  console.log('Document type:', analysis.document_type);
  console.log('Description (RU):', analysis.description_ru);
  console.log('Year:', analysis.year_estimate);
  console.log('Period:', analysis.historical_period);
  console.log('Document text:', analysis.document_text ? analysis.document_text.slice(0, 200) + '...' : 'null');
  console.log('Document info:', JSON.stringify(analysis.document_info, null, 2));
  console.log('Tags RU:', (analysis.tags_ru || []).join(', '));
}

main().catch(err => console.error('Error:', err.message));
