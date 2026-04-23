CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  filepath TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK(type IN ('video', 'audio', 'image')),
  duration REAL,
  width INTEGER,
  height INTEGER,
  fps REAL,
  codec TEXT,
  size INTEGER NOT NULL,
  thumbnail TEXT,
  md5_hash TEXT,
  drive_file_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'rendering', 'done', 'error')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_timeline (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id),
  track INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL DEFAULT 0,
  start_trim REAL NOT NULL DEFAULT 0,
  end_trim REAL NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_analysis (
  media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  document_type TEXT,
  persons TEXT,
  person_positions TEXT,
  year_estimate TEXT,
  event TEXT,
  location TEXT,
  country TEXT,
  era TEXT,
  historical_period TEXT,
  mood TEXT,
  shot_type TEXT,
  setting TEXT,
  military_equipment TEXT,
  uniforms TEXT,
  photo_nature TEXT,
  quality TEXT,
  preservation TEXT,
  description_ru TEXT,
  description_en TEXT,
  document_text TEXT,
  document_info TEXT,
  frames_analyzed INTEGER,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS media_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  language TEXT NOT NULL CHECK(language IN ('ru', 'en')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tags_media ON media_tags(media_id);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON media_tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_lang ON media_tags(media_id, language);
CREATE INDEX IF NOT EXISTS idx_analysis_period ON media_analysis(historical_period);
CREATE INDEX IF NOT EXISTS idx_analysis_year ON media_analysis(year_estimate);
CREATE INDEX IF NOT EXISTS idx_analysis_doctype ON media_analysis(document_type);


CREATE INDEX IF NOT EXISTS idx_media_type ON media(type);
CREATE INDEX IF NOT EXISTS idx_media_filename ON media(filename);
CREATE UNIQUE INDEX IF NOT EXISTS idx_media_drive ON media(drive_file_id);
CREATE INDEX IF NOT EXISTS idx_timeline_project ON project_timeline(project_id);
