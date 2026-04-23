const fs = require('fs');
const path = require('path');
const { execSync, spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');
const { kenBurnsForScene, smartKenBurns } = require('./kenBurns');
const { buildFilterChain, countdownLeader } = require('./filmEffects');
const { loadTokens, getAuthedClient } = require('./googleDrive');
const { google } = require('googleapis');

const FFMPEG_PATH = process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg';
const TEMP_DIR = path.resolve(process.env.TEMP_DIR || './temp');
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || './output');
const THUMBNAILS_DIR = path.resolve(process.env.THUMBNAILS_DIR || './thumbnails');
const MEDIA_DIR = path.resolve(process.env.MEDIA_DIR || '../media-library');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function checkFfmpeg() {
  try {
    const version = execSync(`"${FFMPEG_PATH}" -version`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().split('\n')[0];
    console.log(`    [ffmpeg] Found: ${version}`);
    console.log(`    [ffmpeg] Path: ${FFMPEG_PATH}`);
    return true;
  } catch {
    console.error(`    [ffmpeg] Not found at: ${FFMPEG_PATH}`);
    return false;
  }
}

function ffmpeg(args, label) {
  return new Promise((resolve, reject) => {
    const cmdPreview = ['ffmpeg', '-y', ...args].join(' ');
    console.log(`    [ffmpeg] ${label}`);
    console.log(`    [ffmpeg] cmd: ffmpeg -y ${args.slice(0, 6).join(' ')}${args.length > 6 ? ' ...' : ''}`);

    const proc = spawn(FFMPEG_PATH, ['-y', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) {
        const lastLines = stderr.split('\n').filter(l => l.trim()).slice(-5).join('\n');
        console.error(`    [ffmpeg] FAILED ${label} (exit ${code}):\n${lastLines}`);
        reject(new Error(`ffmpeg ${label} failed (exit ${code}): ${lastLines}`));
      } else {
        console.log(`    [ffmpeg] OK ${label}`);
        resolve();
      }
    });
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        console.error('    [ffmpeg] ERROR: ffmpeg binary not found. Install: brew install ffmpeg');
        reject(new Error('ffmpeg not installed. Run: brew install ffmpeg'));
      } else {
        console.error(`    [ffmpeg] ERROR spawning: ${err.message}`);
        reject(err);
      }
    });
  });
}

// --- Download original from Google Drive ---

function findFileRecursive(dir, filename) {
  if (!fs.existsSync(dir)) return null;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === filename) return full;
      if (e.isDirectory()) {
        const found = findFileRecursive(full, filename);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

async function downloadFromDrive(driveFileId, filename, destDir) {
  const tokens = loadTokens();
  if (!tokens) throw new Error('No Google tokens — cannot download from Drive');

  const auth = getAuthedClient(tokens);
  const drive = google.drive({ version: 'v3', auth });

  ensureDir(destDir);
  const destPath = path.join(destDir, `${driveFileId}_${filename}`);

  // Skip if already cached
  if (fs.existsSync(destPath)) {
    console.log(`      Drive cache hit: ${destPath}`);
    return destPath;
  }

  const res = await drive.files.get(
    { fileId: driveFileId, alt: 'media' },
    { responseType: 'stream' }
  );

  const dest = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    res.data.pipe(dest);
    dest.on('finish', resolve);
    dest.on('error', reject);
  });

  const size = fs.statSync(destPath).size;
  console.log(`      Downloaded from Drive: ${filename} (${(size / 1024).toFixed(0)} KB)`);
  return destPath;
}

// --- Find best quality image for a media entry ---

async function findBestImage(media, cacheDir) {
  console.log(`      Looking for image: ${media.filename}`);
  console.log(`      filepath in DB: ${media.filepath}`);

  // Priority 1: original file on disk (local imports)
  if (media.filepath && !media.filepath.startsWith('gdrive://') && fs.existsSync(media.filepath)) {
    const size = fs.statSync(media.filepath).size;
    console.log(`      -> USING original file: ${media.filepath} (${(size / 1024).toFixed(0)} KB)`);
    return media.filepath;
  }

  // Priority 2: download original from Google Drive
  if (media.drive_file_id) {
    try {
      const driveOriginal = await downloadFromDrive(media.drive_file_id, media.filename, cacheDir);
      const size = fs.statSync(driveOriginal).size;
      console.log(`      -> USING Drive original: ${driveOriginal} (${(size / 1024).toFixed(0)} KB)`);
      return driveOriginal;
    } catch (err) {
      console.warn(`      Drive download failed: ${err.message}`);
    }
  }

  // Priority 3: look in media-library/
  if (media.filename) {
    const cleanName = media.filename.replace(/^[^_]+_/, '');
    const dirs = [MEDIA_DIR, path.join(MEDIA_DIR, 'photos')];
    for (const dir of dirs) {
      for (const name of [media.filename, cleanName]) {
        const p = path.join(dir, name);
        if (fs.existsSync(p)) {
          const size = fs.statSync(p).size;
          console.log(`      -> USING media-library: ${p} (${(size / 1024).toFixed(0)} KB)`);
          return p;
        }
      }
    }
  }

  // Priority 4: thumbnail as last resort
  if (media.thumbnail) {
    const thumbPath = path.join(THUMBNAILS_DIR, media.thumbnail);
    if (fs.existsSync(thumbPath)) {
      const size = fs.statSync(thumbPath).size;
      console.log(`      -> FALLBACK thumbnail (320x180): ${thumbPath} (${(size / 1024).toFixed(0)} KB)`);
      return thumbPath;
    }
  }

  console.log(`      -> NO IMAGE FOUND`);
  return null;
}

// --- Render one scene: photo → Ken Burns video clip with film effects ---

async function renderScene(scene, index, style, intensity, workDir) {
  const db = getDb();
  const photo = scene.selected_photo;
  if (!photo) return null;

  const media = db.prepare('SELECT filename, filepath, thumbnail, drive_file_id FROM media WHERE id = ?').get(photo.media_id);
  if (!media) return null;

  const cacheDir = path.join(workDir, 'originals');
  const imagePath = await findBestImage(media, cacheDir);
  if (!imagePath) {
    console.warn(`    Scene ${index + 1}: no image file found for ${photo.filename}`);
    return null;
  }

  const duration = scene.end_time - scene.start_time;
  if (duration <= 0) return null;

  const outputPath = path.join(workDir, `scene_${String(index).padStart(3, '0')}.mp4`);

  // Get photo analysis for Ken Burns
  const analysis = db.prepare('SELECT * FROM media_analysis WHERE media_id = ?').get(photo.media_id);
  let parsedAnalysis = null;
  if (analysis) {
    parsedAnalysis = {
      persons: analysis.persons ? JSON.parse(analysis.persons) : [],
      person_positions: analysis.person_positions ? JSON.parse(analysis.person_positions) : {},
      shot_type: analysis.shot_type,
      setting: analysis.setting,
      description_ru: analysis.description_ru,
    };
  }

  // Get Ken Burns movement — use Claude for selection
  let kbFilter;
  try {
    const kb = await kenBurnsForScene(scene.narration || '', parsedAnalysis, duration);
    kbFilter = kb.filter;
    console.log(`    Scene ${index + 1}: ${kb.movement}${kb.target_person ? ' → ' + kb.target_person : ''} (${duration.toFixed(1)}s)`);
  } catch (err) {
    console.warn(`    Scene ${index + 1}: Ken Burns selection failed, using zoom_in_center`);
    const kb = smartKenBurns(parsedAnalysis, duration, { movement: 'zoom_in_center' });
    kbFilter = kb.filter;
  }

  // Get film effects for the style
  const fx = buildFilterChain(style, intensity);

  // Filter chain: upscale to 1920x1080 → Ken Burns zoompan → film effects
  // Ken Burns already includes scale=8000:-1 for smooth zoom, so we replace it
  // with a proper scale to 1920:1080 first, then zoompan at high res
  const filterComplex = `scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,${kbFilter},${fx.filterString},format=yuv420p`;

  await ffmpeg([
    '-loop', '1', '-i', imagePath,
    '-filter_complex', filterComplex,
    '-t', String(duration),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ], `scene ${index + 1}/${scene.scene_number}`);

  return outputPath;
}

// --- Generate countdown leader clip ---

async function renderCountdown(style, workDir, fps = 24) {
  const outputPath = path.join(workDir, 'countdown.mp4');
  const cd = countdownLeader(fps);

  // Build the filter_complex string for countdown
  const filterComplex = cd.filters.join(';');

  await ffmpeg([
    '-filter_complex', filterComplex,
    '-map', cd.outputLabel,
    '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ], 'countdown leader');

  return outputPath;
}

// --- Concatenate scene clips + audio → final video ---

async function concatenateScenes(scenePaths, audioPath, outputPath, workDir) {
  // Write concat list
  const listPath = path.join(workDir, 'concat.txt');
  const listContent = scenePaths.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(listPath, listContent);

  // Concat video segments — copy codec (scenes already encoded at high quality)
  const silentPath = path.join(workDir, 'silent.mp4');
  await ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', listPath,
    '-c:v', 'copy',
    '-movflags', '+faststart',
    silentPath,
  ], 'concat scenes');

  // Overlay audio if available
  if (audioPath && fs.existsSync(audioPath)) {
    await ffmpeg([
      '-i', silentPath,
      '-i', audioPath,
      '-c:v', 'copy',
      '-c:a', 'aac', '-b:a', '192k',
      '-map', '0:v:0', '-map', '1:a:0',
      '-shortest',
      outputPath,
    ], 'merge audio');
  } else {
    // No audio — just add silent audio track for compatibility
    await ffmpeg([
      '-i', silentPath,
      '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
      '-c:v', 'copy', '-c:a', 'aac', '-shortest',
      outputPath,
    ], 'add silent audio');
  }

  return outputPath;
}

// --- Main render pipeline ---

async function renderProject(projectId) {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
  if (!project) throw new Error('Project not found');

  const scenes = JSON.parse(project.storyboard || '[]');
  if (scenes.length === 0) throw new Error('Project has no storyboard scenes');

  const style = project.style || 'chronicle';
  const intensity = 0.7;

  // Update status
  db.prepare("UPDATE projects SET status = 'rendering', updated_at = datetime('now') WHERE id = ?").run(projectId);

  const workDir = path.join(TEMP_DIR, `render_${projectId}`);
  ensureDir(workDir);
  ensureDir(OUTPUT_DIR);

  const outputFilename = `${project.name.replace(/[^a-zA-Zа-яА-ЯёЁ0-9_-]/g, '_')}_${Date.now()}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputFilename);

  try {
    console.log(`  [render] Project: ${project.name}`);
    console.log(`  [render] Scenes: ${scenes.length}, Style: ${style}, Intensity: ${intensity}`);
    console.log(`  [render] Work dir: ${workDir}`);
    console.log(`  [render] Output: ${outputPath}`);

    // 0. Check ffmpeg
    if (!checkFfmpeg()) {
      throw new Error('ffmpeg not installed. Run: brew install ffmpeg');
    }

    // 1. Render each scene
    const scenePaths = [];
    const fxData = buildFilterChain(style, intensity);
    console.log(`  [render] Film style: ${fxData.description}`);

    // Optional countdown for archive style
    if (fxData.countdown) {
      console.log('  [render] Generating countdown leader...');
      try {
        const cdPath = await renderCountdown(style, workDir);
        scenePaths.push(cdPath);
        console.log('  [render] Countdown leader: OK');
      } catch (err) {
        console.warn(`  [render] Countdown leader failed: ${err.message}`);
      }
    }

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const dur = (scene.end_time - scene.start_time).toFixed(1);
      const photoName = scene.selected_photo?.filename || 'no photo';
      console.log(`  [render] Scene ${i + 1}/${scenes.length}: ${dur}s, photo=${photoName}`);

      try {
        const clipPath = await renderScene(scene, i, style, intensity, workDir);
        if (clipPath) {
          const clipSize = (fs.statSync(clipPath).size / 1024).toFixed(0);
          console.log(`  [render] Scene ${i + 1}: OK (${clipSize} KB)`);
          scenePaths.push(clipPath);
        } else {
          console.warn(`  [render] Scene ${i + 1}: skipped (no usable photo)`);
        }
      } catch (err) {
        console.error(`  [render] Scene ${i + 1} FAILED: ${err.message}`);
      }
    }

    console.log(`  [render] Rendered ${scenePaths.length}/${scenes.length} scenes`);

    if (scenePaths.length === 0) {
      throw new Error('No scenes were rendered successfully. Check that photos exist and ffmpeg is working.');
    }

    // 2. Find audio file
    let audioPath = null;

    // Priority 1: audio_path stored in project
    if (project.audio_path && fs.existsSync(project.audio_path)) {
      audioPath = project.audio_path;
      console.log(`  [render] Audio from project.audio_path: ${audioPath}`);
    }

    // Priority 2: audio in timeline
    if (!audioPath) {
      const audioEntry = db.prepare(`
        SELECT m.filepath FROM project_timeline pt
        JOIN media m ON m.id = pt.media_id
        WHERE pt.project_id = ? AND m.type = 'audio'
        ORDER BY pt.sort_order LIMIT 1
      `).get(projectId);
      if (audioEntry && fs.existsSync(audioEntry.filepath)) {
        audioPath = audioEntry.filepath;
        console.log(`  [render] Audio from timeline: ${audioPath}`);
      }
    }

    // Priority 3: try to find by original name from description
    if (!audioPath && project.description) {
      const match = project.description.match(/Audio:\s*(.+?),/);
      if (match) {
        const origName = match[1].trim();
        const searchDirs = [
          path.resolve('./uploads'),
          TEMP_DIR,
          path.resolve('../'),
        ];
        for (const dir of searchDirs) {
          const found = findFileRecursive(dir, origName);
          if (found) {
            audioPath = found;
            console.log(`  [render] Audio found by name: ${audioPath}`);
            break;
          }
        }
      }
    }

    if (audioPath) {
      const audioSize = (fs.statSync(audioPath).size / 1024).toFixed(0);
      console.log(`  [render] Audio: ${audioPath} (${audioSize} KB)`);
    } else {
      console.log('  [render] No audio track — output will be silent');
    }

    // 3. Concatenate + merge audio
    console.log(`  [render] Concatenating ${scenePaths.length} clips...`);
    await concatenateScenes(scenePaths, audioPath, outputPath, workDir);

    // 4. Update project
    const stat = fs.statSync(outputPath);
    db.prepare(`
      UPDATE projects SET status = 'done', updated_at = datetime('now') WHERE id = ?
    `).run(projectId);

    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    console.log(`  [render] COMPLETE: ${outputFilename} (${sizeMB} MB)`);

    return {
      output_path: outputPath,
      output_filename: outputFilename,
      size_bytes: stat.size,
      scenes_rendered: scenePaths.length,
    };
  } catch (err) {
    console.error(`  [render] FATAL ERROR: ${err.message}`);
    // Save error message to DB for status endpoint
    db.prepare(
      "UPDATE projects SET status = 'error', description = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(`Render error: ${err.message}`, projectId);
    throw err;
  } finally {
    // Cleanup work directory
    try {
      fs.rmSync(workDir, { recursive: true });
    } catch {}
  }
}

module.exports = { renderProject, renderScene };
