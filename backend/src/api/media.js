const express = require('express');
const path = require('path');
const { getDb } = require('../database');
const { indexFile } = require('../services/mediaIndexer');
const { getAuthedClient, loadTokens, syncFolder } = require('../services/googleDrive');

const router = express.Router();

// GET /api/media — list all media with optional filters
router.get('/', (req, res) => {
  const { type, search, limit = 100, offset = 0 } = req.query;
  const db = getDb();

  let sql = 'SELECT * FROM media WHERE 1=1';
  const params = [];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  if (search) {
    sql += ' AND filename LIKE ?';
    params.push(`%${search}%`);
  }

  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const rows = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as count FROM media').get().count;

  res.json({ data: rows, total, limit: Number(limit), offset: Number(offset) });
});

// GET /api/media/search/tags?q=война&lang=ru — search by tags
router.get('/search/tags', (req, res) => {
  const { q, lang, limit = 50 } = req.query;
  if (!q) return res.status(400).json({ error: 'q (search query) is required' });

  const db = getDb();

  let sql = `
    SELECT DISTINCT m.*, ma.description_ru, ma.description_en, ma.year_estimate, ma.historical_period
    FROM media m
    JOIN media_tags mt ON mt.media_id = m.id
    LEFT JOIN media_analysis ma ON ma.media_id = m.id
    WHERE mt.tag LIKE ?
  `;
  const params = [`%${q}%`];

  if (lang) {
    sql += ' AND mt.language = ?';
    params.push(lang);
  }

  sql += ' ORDER BY m.created_at DESC LIMIT ?';
  params.push(Number(limit));

  const rows = db.prepare(sql).all(...params);
  res.json({ data: rows, query: q, total: rows.length });
});

// GET /api/media/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM media WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Media not found' });
  res.json(row);
});

// POST /api/media/index — index a single file by path
router.post('/index', async (req, res) => {
  const { filepath } = req.body;
  if (!filepath) return res.status(400).json({ error: 'filepath is required' });

  const thumbnailDir = path.resolve(process.env.THUMBNAILS_DIR || './thumbnails');

  try {
    const id = await indexFile(path.resolve(filepath), thumbnailDir);
    if (!id) return res.status(400).json({ error: 'Unsupported file type' });

    const db = getDb();
    const media = db.prepare('SELECT * FROM media WHERE id = ?').get(id);
    res.status(201).json(media);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/media/sync-drive — sync photos from a Google Drive folder
router.post('/sync-drive', async (req, res) => {
  const folderId = req.body.folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
  if (!folderId) return res.status(400).json({ error: 'folderId is required (pass in body or set GOOGLE_DRIVE_FOLDER_ID in .env)' });

  // Use tokens from body, or fall back to saved tokens.json
  const tokens = req.body.tokens || loadTokens();
  if (!tokens || !tokens.access_token) {
    return res.status(401).json({
      error: 'No tokens found. Visit /api/auth/google to authorize first.',
    });
  }

  const thumbnailDir = path.resolve(process.env.THUMBNAILS_DIR || './thumbnails');

  try {
    const auth = getAuthedClient(tokens);
    const results = await syncFolder(auth, folderId, thumbnailDir);
    res.json(results);
  } catch (err) {
    if (err.code === 401 || err.code === 403) {
      return res.status(401).json({ error: 'Google token expired or invalid. Re-authorize at /api/auth/google' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/media/:id/analysis — get Claude Vision analysis
router.get('/:id/analysis', (req, res) => {
  const db = getDb();
  const media = db.prepare('SELECT id FROM media WHERE id = ?').get(req.params.id);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  const analysis = db.prepare('SELECT * FROM media_analysis WHERE media_id = ?').get(req.params.id);
  if (!analysis) return res.status(404).json({ error: 'No analysis found. Run sync-drive to analyze.' });

  const tags = db.prepare('SELECT tag, language FROM media_tags WHERE media_id = ?').all(req.params.id);

  res.json({
    ...analysis,
    persons: JSON.parse(analysis.persons || '[]'),
    person_positions: JSON.parse(analysis.person_positions || '{}'),
    military_equipment: JSON.parse(analysis.military_equipment || '{}'),
    uniforms: JSON.parse(analysis.uniforms || '{}'),
    document_info: JSON.parse(analysis.document_info || '{}'),
    tags: {
      ru: tags.filter(t => t.language === 'ru').map(t => t.tag),
      en: tags.filter(t => t.language === 'en').map(t => t.tag),
    },
  });
});

// DELETE /api/media/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM media WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Media not found' });
  res.json({ deleted: true });
});

module.exports = router;
