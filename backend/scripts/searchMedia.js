require('dotenv').config({ path: './config/.env' });
const { getDb } = require('../src/database');

const db = getDb();
const keywords = process.argv.slice(2).length > 0
  ? process.argv.slice(2)
  : ['Кремль', 'Лубянка', 'Завьялов', 'Ижорский', 'заседание', '1936'];

for (const kw of keywords) {
  const rows = db.prepare(`
    SELECT DISTINCT m.id, m.filename, ma.description_ru, ma.year_estimate, ma.historical_period
    FROM media m
    LEFT JOIN media_tags mt ON mt.media_id = m.id
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE mt.tag LIKE ? OR ma.description_ru LIKE ? OR ma.description_en LIKE ? OR ma.year_estimate LIKE ?
  `).all(`%${kw}%`, `%${kw}%`, `%${kw}%`, `%${kw}%`);

  console.log(`\n  "${kw}" — ${rows.length} results`);
  console.log('  ' + '─'.repeat(100));

  for (const r of rows) {
    const name = r.filename.replace(/^[A-Za-z0-9_-]{20,}_/, '');
    const tags = db.prepare("SELECT tag FROM media_tags WHERE media_id = ? AND language = 'ru'").all(r.id).map(t => t.tag);
    console.log(`  ${name}`);
    console.log(`    Year: ${r.year_estimate || '?'} | Period: ${r.historical_period || '?'}`);
    console.log(`    Desc: ${(r.description_ru || '').slice(0, 90)}`);
    console.log(`    Tags: ${tags.join(', ')}`);
    console.log('');
  }
}
