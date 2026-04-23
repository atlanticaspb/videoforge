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

function runMigrations(database) {
  // Migrate media table
  const mediaCols = database.pragma('table_info(media)').map(c => c.name);
  if (mediaCols.length > 0) {
    if (!mediaCols.includes('drive_file_id')) {
      database.exec('ALTER TABLE media ADD COLUMN drive_file_id TEXT');
    }
    if (!mediaCols.includes('md5_hash')) {
      database.exec('ALTER TABLE media ADD COLUMN md5_hash TEXT');
    }
  }

  // Migrate media_analysis table
  const analysisCols = database.pragma('table_info(media_analysis)').map(c => c.name);
  if (analysisCols.length > 0) {
    if (!analysisCols.includes('document_type')) {
      database.exec('ALTER TABLE media_analysis ADD COLUMN document_type TEXT');
    }
    if (!analysisCols.includes('document_text')) {
      database.exec('ALTER TABLE media_analysis ADD COLUMN document_text TEXT');
    }
    if (!analysisCols.includes('document_info')) {
      database.exec('ALTER TABLE media_analysis ADD COLUMN document_info TEXT');
    }
    if (!analysisCols.includes('frames_analyzed')) {
      database.exec('ALTER TABLE media_analysis ADD COLUMN frames_analyzed INTEGER');
    }
    if (!analysisCols.includes('person_positions')) {
      database.exec('ALTER TABLE media_analysis ADD COLUMN person_positions TEXT');
    }
  }
}

function initDatabase() {
  const database = getDb();

  // Run migrations BEFORE schema (adds missing columns to existing tables)
  runMigrations(database);

  // Create tables + indexes (safe for both fresh and migrated DBs)
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  database.exec(schema);

  console.log('Database initialized at', DB_PATH);
}

module.exports = { getDb, initDatabase };
