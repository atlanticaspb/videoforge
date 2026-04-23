const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const FormData = require('form-data');
const { getDb } = require('../database');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// --- Audio format detection ---

function detectAudioMime(filepath) {
  const buf = Buffer.alloc(12);
  const fd = fs.openSync(filepath, 'r');
  fs.readSync(fd, buf, 0, 12, 0);
  fs.closeSync(fd);

  const hex = buf.toString('hex').toUpperCase();
  const magicStr = buf.toString('ascii', 0, 4);

  // MP3: starts with ID3 tag or MPEG frame sync (FF FB, FF F3, FF F2)
  if (magicStr.startsWith('ID3') || hex.startsWith('FFFB') || hex.startsWith('FFF3') || hex.startsWith('FFF2')) {
    return 'audio/mpeg';
  }
  // WAV: RIFF....WAVE
  if (magicStr === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  // OGG
  if (magicStr === 'OggS') return 'audio/ogg';
  // FLAC
  if (magicStr === 'fLaC') return 'audio/flac';
  // M4A/MP4: ftyp at offset 4
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'audio/mp4';

  // Fallback to extension
  const ext = path.extname(filepath).toLowerCase();
  const extMap = {
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
    '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.webm': 'audio/webm', '.mp4': 'audio/mp4',
  };
  return extMap[ext] || 'audio/mpeg';
}

function logFileInfo(filepath) {
  const stat = fs.statSync(filepath);
  const buf = Buffer.alloc(16);
  const fd = fs.openSync(filepath, 'r');
  fs.readSync(fd, buf, 0, 16, 0);
  fs.closeSync(fd);
  const hex = buf.toString('hex').toUpperCase().match(/.{2}/g).join(' ');
  console.log(`    File: ${filepath}`);
  console.log(`    Size: ${stat.size} bytes (${(stat.size / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`    Magic bytes: ${hex}`);
  console.log(`    Detected MIME: ${detectAudioMime(filepath)}`);
}

// --- Whisper transcription: Groq (free) → OpenAI → local faster-whisper ---

async function transcribeViaGroq(audioPath) {
  const form = new FormData();
  const filename = path.basename(audioPath);
  // Detect MIME from magic bytes + extension
  const mimeType = detectAudioMime(audioPath);
  console.log(`    Groq upload: ${filename}, mime=${mimeType}, size=${fs.statSync(audioPath).size} bytes`);
  form.append('file', fs.createReadStream(audioPath), { filename, contentType: mimeType });
  form.append('model', 'whisper-large-v3');
  form.append('response_format', 'verbose_json');
  form.append('language', 'ru');

  const res = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', form, {
    headers: {
      'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return {
    text: res.data.text,
    segments: res.data.segments || [],
    duration: res.data.duration,
    provider: 'groq',
  };
}

async function transcribeViaOpenAI(audioPath) {
  const form = new FormData();
  const mimeType = detectAudioMime(audioPath);
  form.append('file', fs.createReadStream(audioPath), { filename: path.basename(audioPath), contentType: mimeType });
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('language', 'ru');

  const res = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      ...form.getHeaders(),
    },
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });

  return {
    text: res.data.text,
    segments: res.data.segments || [],
    duration: res.data.duration,
    provider: 'openai',
  };
}

async function transcribeViaLocal(audioPath) {
  const { execSync } = require('child_process');

  // Check if faster-whisper is available
  try {
    execSync('which faster-whisper 2>/dev/null || python3 -c "import faster_whisper" 2>/dev/null', { stdio: 'ignore' });
  } catch {
    throw new Error('faster-whisper not installed. Run: pip install faster-whisper');
  }

  const outputPath = audioPath + '.json';
  const script = `
import json, sys
from faster_whisper import WhisperModel
model = WhisperModel("large-v3", compute_type="int8")
segments, info = model.transcribe("${audioPath.replace(/"/g, '\\"')}", language="ru")
result = {"text": "", "segments": [], "duration": info.duration}
for s in segments:
    result["segments"].append({"start": s.start, "end": s.end, "text": s.text})
    result["text"] += s.text + " "
result["text"] = result["text"].strip()
with open("${outputPath.replace(/"/g, '\\"')}", "w") as f:
    json.dump(result, f, ensure_ascii=False)
`;

  execSync(`python3 -c '${script.replace(/'/g, "'\"'\"'")}'`, {
    timeout: 300000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const result = JSON.parse(fs.readFileSync(outputPath, 'utf-8'));
  fs.unlinkSync(outputPath);

  return { ...result, provider: 'local-faster-whisper' };
}

async function transcribeAudio(audioPath) {
  console.log('    GROQ KEY:', process.env.GROQ_API_KEY ? 'присутствует' : 'отсутствует');
  console.log('    OPENAI KEY:', process.env.OPENAI_API_KEY ? 'присутствует' : 'отсутствует');
  logFileInfo(audioPath);

  // Priority: Groq (free) → OpenAI → local faster-whisper
  const providers = [];

  if (process.env.GROQ_API_KEY) providers.push({ name: 'Groq', fn: transcribeViaGroq });
  if (process.env.OPENAI_API_KEY) providers.push({ name: 'OpenAI', fn: transcribeViaOpenAI });
  providers.push({ name: 'local faster-whisper', fn: transcribeViaLocal });

  for (const { name, fn } of providers) {
    try {
      console.log(`    Trying transcription via ${name}...`);
      const result = await fn(audioPath);
      console.log(`    Transcribed via ${name}: ${result.text.length} chars`);
      return result;
    } catch (err) {
      const detail = err.response?.data ? JSON.stringify(err.response.data) : '';
      console.warn(`    ${name} failed: ${err.message}${detail ? ' | ' + detail : ''}`);
    }
  }

  throw new Error('All transcription providers failed. Set GROQ_API_KEY (free), OPENAI_API_KEY, or install faster-whisper (pip install faster-whisper)');
}

// --- Claude scene splitting ---

function buildScenePrompt(transcription, context) {
  return `Ты — режиссёр документального фильма. Тебе дана транскрипция аудиодорожки и контекст.
Разбей текст на сцены для видеоряда. Каждая сцена = один визуальный кадр (3-8 секунд).

КОНТЕКСТ:
- Период: ${context.period || 'не указан'}
- Страна: ${context.country || 'не указана'}
- Персоны: ${(context.persons || []).join(', ') || 'не указаны'}
- Место: ${context.location || 'не указано'}
- Тема: ${context.topic || 'не указана'}
- Стиль: ${context.style || 'documentary'}

ТРАНСКРИПЦИЯ:
${transcription.text}

Верни JSON (без markdown-обёртки):
{
  "title": "название проекта на русском",
  "scenes": [
    {
      "scene_number": 1,
      "start_time": 0.0,
      "end_time": 5.5,
      "narration": "текст дикторского текста для этой сцены",
      "visual_description": "описание того, что должно быть в кадре",
      "search_tags_ru": ["тег1", "тег2", "тег3"],
      "search_tags_en": ["tag1", "tag2", "tag3"],
      "search_persons": ["Имя Фамилия"],
      "search_period": "ВОВ",
      "search_setting": "военная|гражданская|смешанная",
      "preferred_shot_type": "портрет|группа|панорама|деталь"
    }
  ]
}

Правила:
- Сцены должны покрывать всю транскрипцию без пропусков
- Для каждой сцены укажи теги для поиска подходящих фото в архиве
- search_persons — кто должен быть на фото (если применимо)
- Стиль "${context.style || 'documentary'}" влияет на выбор кадров:
  chronicle = хроникальные кадры, documentary = документальные фото,
  colorized = цветные/колоризованные, poster = плакаты и агитация`;
}

async function splitIntoScenes(transcription, context) {
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [
      { role: 'user', content: buildScenePrompt(transcription, context) },
    ],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1].trim());
    throw new Error(`Failed to parse scene breakdown: ${text.slice(0, 300)}`);
  }
}

// --- Photo matching from media library ---

function findPhotosForScene(scene) {
  const db = getDb();
  const candidates = [];

  // Search by person names
  for (const person of scene.search_persons || []) {
    const rows = db.prepare(`
      SELECT m.id, m.filename, m.thumbnail, ma.description_ru, ma.year_estimate,
             ma.historical_period, ma.shot_type, ma.persons
      FROM media m
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE ma.persons LIKE ?
      ORDER BY m.created_at DESC
      LIMIT 10
    `).all(`%${person}%`);
    candidates.push(...rows.map(r => ({ ...r, match_reason: `person: ${person}`, score: 10 })));
  }

  // Search by tags (RU)
  for (const tag of scene.search_tags_ru || []) {
    const rows = db.prepare(`
      SELECT DISTINCT m.id, m.filename, m.thumbnail, ma.description_ru, ma.year_estimate,
             ma.historical_period, ma.shot_type
      FROM media m
      JOIN media_tags mt ON mt.media_id = m.id
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE mt.tag LIKE ? AND mt.language = 'ru'
      LIMIT 5
    `).all(`%${tag}%`);
    candidates.push(...rows.map(r => ({ ...r, match_reason: `tag_ru: ${tag}`, score: 5 })));
  }

  // Search by tags (EN)
  for (const tag of scene.search_tags_en || []) {
    const rows = db.prepare(`
      SELECT DISTINCT m.id, m.filename, m.thumbnail, ma.description_ru, ma.year_estimate,
             ma.historical_period, ma.shot_type
      FROM media m
      JOIN media_tags mt ON mt.media_id = m.id
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE mt.tag LIKE ? AND mt.language = 'en'
      LIMIT 5
    `).all(`%${tag}%`);
    candidates.push(...rows.map(r => ({ ...r, match_reason: `tag_en: ${tag}`, score: 5 })));
  }

  // Search by historical period
  if (scene.search_period) {
    const rows = db.prepare(`
      SELECT m.id, m.filename, m.thumbnail, ma.description_ru, ma.year_estimate,
             ma.historical_period, ma.shot_type
      FROM media m
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE ma.historical_period = ?
      LIMIT 10
    `).all(scene.search_period);
    candidates.push(...rows.map(r => ({ ...r, match_reason: `period: ${scene.search_period}`, score: 3 })));
  }

  // Boost score for matching shot_type
  if (scene.preferred_shot_type) {
    for (const c of candidates) {
      if (c.shot_type === scene.preferred_shot_type) c.score += 3;
    }
  }

  // Deduplicate and rank
  const seen = new Map();
  for (const c of candidates) {
    if (seen.has(c.id)) {
      seen.get(c.id).score += c.score;
      seen.get(c.id).match_reasons.push(c.match_reason);
    } else {
      seen.set(c.id, {
        media_id: c.id,
        filename: c.filename,
        thumbnail: c.thumbnail,
        description: c.description_ru,
        year: c.year_estimate,
        period: c.historical_period,
        score: c.score,
        match_reasons: [c.match_reason],
      });
    }
  }

  return [...seen.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
}

// --- Main pipeline ---

async function buildStoryboard(audioPath, context) {
  console.log('  [1/3] Transcribing audio...');
  const transcription = await transcribeAudio(audioPath);
  console.log(`    Transcription: ${transcription.text.length} chars, ${transcription.duration?.toFixed(1)}s`);

  console.log('  [2/3] Splitting into scenes...');
  const sceneData = await splitIntoScenes(transcription, context);
  console.log(`    Generated ${sceneData.scenes.length} scenes`);

  console.log('  [3/3] Matching photos...');
  const scenes = sceneData.scenes.map(scene => {
    const photos = findPhotosForScene(scene);
    console.log(`    Scene ${scene.scene_number}: ${photos.length} candidates`);
    return {
      ...scene,
      matched_photos: photos,
      selected_photo: photos[0] || null,
    };
  });

  return {
    title: sceneData.title,
    transcription,
    scenes,
    context,
  };
}

module.exports = { transcribeAudio, splitIntoScenes, findPhotosForScene, buildStoryboard };
