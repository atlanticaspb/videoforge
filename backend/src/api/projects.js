const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

const router = express.Router();

// GET /api/projects
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM projects ORDER BY updated_at DESC').all();
  res.json({ data: rows });
});

// POST /api/projects
router.post('/', (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const db = getDb();
  const id = uuidv4();
  db.prepare('INSERT INTO projects (id, name, description) VALUES (?, ?, ?)').run(id, name, description || null);

  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
  res.status(201).json(project);
});

// GET /api/projects/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const timeline = db.prepare(`
    SELECT pt.*, m.filename, m.type, m.duration, m.filepath
    FROM project_timeline pt
    JOIN media m ON m.id = pt.media_id
    WHERE pt.project_id = ?
    ORDER BY pt.track, pt.sort_order
  `).all(req.params.id);

  res.json({ ...project, timeline });
});

// PUT /api/projects/:id
router.put('/:id', (req, res) => {
  const { name, description, status } = req.body;
  const db = getDb();

  const existing = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Project not found' });

  db.prepare(`
    UPDATE projects SET name = ?, description = ?, status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(name || existing.name, description ?? existing.description, status || existing.status, req.params.id);

  const updated = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/projects/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const result = db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Project not found' });
  res.json({ deleted: true });
});

// POST /api/projects/:id/timeline — add media to timeline
router.post('/:id/timeline', (req, res) => {
  const { media_id, track = 0, position = 0, start_trim = 0, end_trim = 0 } = req.body;
  if (!media_id) return res.status(400).json({ error: 'media_id is required' });

  const db = getDb();

  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const media = db.prepare('SELECT id FROM media WHERE id = ?').get(media_id);
  if (!media) return res.status(404).json({ error: 'Media not found' });

  const maxOrder = db.prepare(
    'SELECT COALESCE(MAX(sort_order), -1) as max_order FROM project_timeline WHERE project_id = ? AND track = ?'
  ).get(req.params.id, track);

  const id = uuidv4();
  db.prepare(`
    INSERT INTO project_timeline (id, project_id, media_id, track, position, start_trim, end_trim, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.params.id, media_id, track, position, start_trim, end_trim, maxOrder.max_order + 1);

  db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);

  const entry = db.prepare('SELECT * FROM project_timeline WHERE id = ?').get(id);
  res.status(201).json(entry);
});

// DELETE /api/projects/:id/timeline/:entryId
router.delete('/:id/timeline/:entryId', (req, res) => {
  const db = getDb();
  const result = db.prepare(
    'DELETE FROM project_timeline WHERE id = ? AND project_id = ?'
  ).run(req.params.entryId, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Timeline entry not found' });

  db.prepare("UPDATE projects SET updated_at = datetime('now') WHERE id = ?").run(req.params.id);
  res.json({ deleted: true });
});

module.exports = router;
