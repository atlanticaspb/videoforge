const express = require('express');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const { getDb } = require('../database');
const { buildStoryboard } = require('../services/storyboardBuilder');
const { renderProject } = require('../services/renderer');

const TEMP_DIR = path.resolve(process.env.TEMP_DIR || './temp');
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
    cb(null, TEMP_DIR);
  },
  filename: (req, file, cb) => {
    // Keep original extension for MIME detection
    const ext = path.extname(file.originalname);
    cb(null, `upload_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage });

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

// POST /api/projects/create-from-audio — build storyboard from audio
router.post('/create-from-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'audio file is required (multipart field "audio")' });

  const context = {
    period: req.body.period || null,
    country: req.body.country || null,
    persons: req.body.persons ? JSON.parse(req.body.persons) : [],
    location: req.body.location || null,
    topic: req.body.topic || null,
    style: req.body.style || 'documentary',
  };

  try {
    console.log(`Creating storyboard from audio: ${req.file.originalname}`);
    const result = await buildStoryboard(req.file.path, context);

    // Persist audio file to uploads/
    const uploadsDir = path.resolve(process.env.UPLOADS_DIR || './uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
    const audioExt = path.extname(req.file.originalname) || '.mp3';
    const audioFilename = `audio_${Date.now()}${audioExt}`;
    const audioPersistPath = path.join(uploadsDir, audioFilename);
    fs.copyFileSync(req.file.path, audioPersistPath);
    console.log(`  Audio saved to: ${audioPersistPath}`);

    // Create project in DB
    const db = getDb();
    const id = uuidv4();
    db.prepare(`
      INSERT INTO projects (id, name, description, style, transcription, storyboard, audio_path)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      result.title || `Project from ${req.file.originalname}`,
      `Audio: ${req.file.originalname}, ${result.scenes.length} scenes`,
      context.style,
      result.transcription.text,
      JSON.stringify(result.scenes),
      audioPersistPath
    );

    // Add selected photos to timeline
    const insertTimeline = db.prepare(`
      INSERT INTO project_timeline (id, project_id, media_id, track, position, sort_order)
      VALUES (?, ?, ?, 0, ?, ?)
    `);

    let position = 0;
    for (let i = 0; i < result.scenes.length; i++) {
      const scene = result.scenes[i];
      if (scene.selected_photo) {
        insertTimeline.run(
          uuidv4(), id, scene.selected_photo.media_id,
          position, i
        );
      }
      position += (scene.end_time - scene.start_time);
    }

    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(id);

    res.status(201).json({
      project: {
        ...project,
        storyboard: JSON.parse(project.storyboard || '[]'),
      },
      scenes: result.scenes,
      transcription: result.transcription,
    });
  } catch (err) {
    console.error('Storyboard creation failed:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    // Clean up uploaded audio
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
  }
});

// POST /api/projects/:id/render — render storyboard to final MP4
router.post('/:id/render', async (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  if (project.status === 'rendering') {
    return res.status(409).json({ error: 'Project is already rendering' });
  }

  const storyboard = JSON.parse(project.storyboard || '[]');
  if (storyboard.length === 0) {
    return res.status(400).json({ error: 'Project has no storyboard. Use /create-from-audio first.' });
  }

  // Start render in background — respond immediately
  res.json({
    message: 'Render started',
    project_id: req.params.id,
    scenes: storyboard.length,
    style: project.style || 'chronicle',
    status: 'rendering',
  });

  // Run render asynchronously
  renderProject(req.params.id)
    .then(result => {
      console.log(`Render finished for project ${req.params.id}: ${result.output_filename}`);
    })
    .catch(err => {
      console.error(`Render failed for project ${req.params.id}:`, err.message);
    });
});

// GET /api/projects/:id/render/status — check render progress
router.get('/:id/render/status', (req, res) => {
  const db = getDb();
  const project = db.prepare('SELECT id, name, status, style, description, updated_at FROM projects WHERE id = ?').get(req.params.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  // Check if output file exists
  const outputDir = path.resolve(process.env.OUTPUT_DIR || './output');
  let outputFile = null;
  if (project.status === 'done' && fs.existsSync(outputDir)) {
    const files = fs.readdirSync(outputDir).filter(f => f.includes(req.params.id) || f.startsWith(project.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_')));
    if (files.length > 0) {
      const latest = files.sort().pop();
      outputFile = {
        filename: latest,
        path: `/output/${latest}`,
        size_bytes: fs.statSync(path.join(outputDir, latest)).size,
      };
    }
  }

  res.json({ ...project, output: outputFile });
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
