require('dotenv').config({ path: './config/.env' });

const express = require('express');
const cors = require('cors');
const path = require('path');
const { initDatabase } = require('./database');
const mediaRoutes = require('./api/media');
const projectRoutes = require('./api/projects');
const { getAuthUrl, getTokensFromCode } = require('./services/googleDrive');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Serve thumbnails
app.use('/thumbnails', express.static(
  path.resolve(process.env.THUMBNAILS_DIR || './thumbnails')
));

// API routes
app.use('/api/media', mediaRoutes);
app.use('/api/projects', projectRoutes);

// Google OAuth2 flow
app.get('/api/auth/google', (req, res) => {
  const url = getAuthUrl();
  res.redirect(url);
});

app.get('/api/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Authorization code missing' });

  try {
    const tokens = await getTokensFromCode(code);
    res.json({
      message: 'Authorized. Use these tokens in POST /api/media/sync-drive',
      tokens,
    });
  } catch (err) {
    res.status(500).json({ error: 'Token exchange failed: ' + err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', version: '1.0.0' });
});

async function start() {
  initDatabase();
  app.listen(PORT, () => {
    console.log(`VideoForge backend running on http://localhost:${PORT}`);
  });
}

start().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
