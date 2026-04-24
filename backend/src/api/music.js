const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { listTracks, MUSIC_DIR } = require('../services/musicSelector');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true });
    cb(null, MUSIC_DIR);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  },
});
const upload = multer({ storage });

const router = express.Router();

// GET /api/music/list — list available music tracks
router.get('/list', (req, res) => {
  const tracks = listTracks();
  res.json({
    data: tracks.map(t => ({
      filename: t.filename,
      mood: t.mood,
      size_bytes: t.size,
    })),
    total: tracks.length,
    music_dir: MUSIC_DIR,
  });
});

// POST /api/music/upload — upload a music track
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file is required (multipart field "file")' });

  const tracks = listTracks();
  const uploaded = tracks.find(t => t.filename === req.file.originalname);

  res.status(201).json({
    message: `Uploaded: ${req.file.originalname}`,
    track: uploaded || { filename: req.file.originalname },
  });
});

module.exports = router;
