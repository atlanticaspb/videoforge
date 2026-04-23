const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '../../data/videoforge.db');

let db;

function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initDatabase() {
  const database = getDb();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  database.exec(schema);

  // Migrations: add columns if missing
  const columns = database.pragma('table_info(media)').map(c => c.name);
  if (!columns.includes('drive_file_id')) {
    database.exec('ALTER TABLE media ADD COLUMN drive_file_id TEXT');
    database.exec('CREATE INDEX IF NOT EXISTS idx_media_drive ON media(drive_file_id)');
  }

  console.log('Database initialized at', DB_PATH);
}

module.exports = { getDb, initDatabase };
