require('dotenv').config({ path: './config/.env' });
const { getDb } = require('../src/database');
const db = getDb();

// Persons from analysis JSON
const rows = db.prepare("SELECT media_id, persons FROM media_analysis WHERE persons != '[]'").all();
const allPersons = new Map();
rows.forEach(r => {
  JSON.parse(r.persons).forEach(p => {
    if (p.name) {
      const key = p.name;
      if (!allPersons.has(key)) allPersons.set(key, { name: p.name, role: p.role, count: 0 });
      allPersons.get(key).count++;
    }
  });
});

console.log('=== Persons identified ===');
[...allPersons.values()]
  .sort((a, b) => b.count - a.count)
  .forEach(p => console.log(`  ${p.name} (${p.role || '?'}) — ${p.count} photo(s)`));

// Tags matching сталин/stalin
console.log('\n=== Tags matching сталин/stalin ===');
const tags = db.prepare("SELECT DISTINCT tag FROM media_tags WHERE tag LIKE '%сталин%' OR tag LIKE '%Stalin%'").all();
tags.forEach(t => console.log('  ' + t.tag));
