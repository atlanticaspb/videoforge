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

// --- Global transcription analysis (persons, period, locations) ---

async function analyzeFullTranscription(transcription) {
  const response = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `Проанализируй транскрипцию документального фильма и извлеки ключевые сущности.
Верни JSON (без markdown-обёртки):
{
  "main_hero": "Фамилия",
  "main_persons": ["Фамилия1", "Фамилия2"],
  "period": "1930-1936",
  "locations": ["Ижорский завод", "Кремль"],
  "main_topic": "краткая тема в 5 словах"
}

main_hero — ГЛАВНЫЙ ГЕРОЙ ролика. Персонаж, о котором весь фильм. Определяй по:
- Кто упомянут в самом начале как центральная фигура
- О чьей жизни/истории/судьбе идёт речь
- Кто совершает ключевые действия в сюжете
- О ком рассказывает диктор от начала до конца
main_persons — ВСЕ персоны упомянутые ПО ИМЕНИ или ФАМИЛИИ. main_hero ВСЕГДА первый в этом списке.
period — временной диапазон событий (YYYY-YYYY).
locations — все конкретные места, здания, города, заводы.

ТРАНСКРИПЦИЯ:
${transcription.text}`,
    }],
  });

  const text = response.content[0].text.trim();
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) result = JSON.parse(match[1].trim());
    else return { main_hero: null, main_persons: [], period: null, locations: [] };
  }

  // Ensure main_hero is first in main_persons
  if (result.main_hero && result.main_persons) {
    result.main_persons = result.main_persons.filter(p => p !== result.main_hero);
    result.main_persons.unshift(result.main_hero);
  }

  return result;
}

// --- Location hierarchy: semantic fallbacks + banned tags ---

const LOCATION_HIERARCHY = {
  'Ижорский завод': {
    fallbacks: ['военный завод', 'танковый завод', 'промышленный цех', 'рабочие станки', 'плавка металла', 'производство танков', 'заводской цех'],
    ban_tags: [],
  },
  'Кремль': {
    fallbacks: ['башни Кремля', 'кремлёвские звёзды', 'здание правительства', 'кабинет вождя', 'Красная площадь', 'советское руководство'],
    ban_tags: ['парад', 'солдаты', 'толпа', 'демонстрация'],
  },
  'Лубянка': {
    fallbacks: ['НКВД здание', 'арест', 'конвой', 'форма НКВД', 'допрос', 'тюрьма'],
    ban_tags: ['парад', 'награждение', 'праздник'],
  },
  'фронт': {
    fallbacks: ['окопы', 'атака', 'бой', 'солдаты в поле', 'передовая', 'артиллерия'],
    ban_tags: ['завод', 'кабинет', 'цех'],
  },
  'завод': {
    fallbacks: ['цех', 'рабочие', 'станки', 'производство', 'плавка', 'конвейер', 'сборка'],
    ban_tags: ['парад', 'кабинет', 'портрет'],
  },
  'Красная площадь': {
    fallbacks: ['парад', 'Мавзолей', 'демонстрация', 'Спасская башня'],
    ban_tags: [],
  },
  'НКВД': {
    fallbacks: ['Лубянка', 'арест', 'конвой', 'допрос', 'репрессии'],
    ban_tags: ['праздник', 'награждение'],
  },
};

function findLocationConfig(location) {
  if (!location) return null;
  const lower = location.toLowerCase();
  for (const [key, config] of Object.entries(LOCATION_HIERARCHY)) {
    if (lower.includes(key.toLowerCase()) || key.toLowerCase().includes(lower)) {
      return config;
    }
  }
  return null;
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

function addCandidates(candidates, rows, reason, score) {
  for (const r of rows) {
    candidates.push({ ...r, match_reason: reason, score });
  }
}

function findPhotosForScene(scene, globalContext = {}) {
  const db = getDb();
  const candidates = [];

  const MEDIA_FIELDS = `m.id, m.filename, m.thumbnail,
    ma.description_ru, ma.year_estimate, ma.historical_period,
    ma.shot_type, ma.persons, ma.person_positions`;

  // Detect location for this scene
  const sceneLocation = scene.search_location || scene.visual_description || '';
  const locationConfig = findLocationConfig(sceneLocation);

  // --- 1. Person search (highest priority) ---
  for (const person of scene.search_persons || []) {
    // Exact match in persons JSON — score 15
    const byPersons = db.prepare(`
      SELECT ${MEDIA_FIELDS} FROM media m
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE ma.persons LIKE ?
      ORDER BY m.created_at DESC LIMIT 10
    `).all(`%${person}%`);
    addCandidates(candidates, byPersons, `person: ${person}`, 15);

    // Bonus: person has position data (we know exactly where they are) — extra +5
    for (const r of byPersons) {
      if (r.person_positions && r.person_positions.includes(person)) {
        candidates.push({ ...r, match_reason: `person_positioned: ${person}`, score: 5 });
      }
    }

    // Fuzzy: search person name in description — score 10
    const nameParts = person.split(/\s+/).filter(p => p.length > 2);
    for (const part of nameParts) {
      const byDesc = db.prepare(`
        SELECT ${MEDIA_FIELDS} FROM media m
        JOIN media_analysis ma ON ma.media_id = m.id
        WHERE (ma.description_ru LIKE ? OR ma.description_en LIKE ?)
          AND ma.persons NOT LIKE ?
        LIMIT 5
      `).all(`%${part}%`, `%${part}%`, `%${person}%`);
      addCandidates(candidates, byDesc, `desc_person: ${part}`, 8);
    }
  }

  // --- 2. Tag search (fuzzy LIKE) ---
  for (const tag of scene.search_tags_ru || []) {
    // Fuzzy tag match
    const byTag = db.prepare(`
      SELECT DISTINCT ${MEDIA_FIELDS} FROM media m
      JOIN media_tags mt ON mt.media_id = m.id
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE mt.tag LIKE ? AND mt.language = 'ru'
      LIMIT 8
    `).all(`%${tag}%`);
    addCandidates(candidates, byTag, `tag_ru: ${tag}`, 5);

    // Description match (2x score) — search in RU description
    const byDesc = db.prepare(`
      SELECT ${MEDIA_FIELDS} FROM media m
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE ma.description_ru LIKE ?
      LIMIT 5
    `).all(`%${tag}%`);
    addCandidates(candidates, byDesc, `desc_ru: ${tag}`, 10);
  }

  for (const tag of scene.search_tags_en || []) {
    const byTag = db.prepare(`
      SELECT DISTINCT ${MEDIA_FIELDS} FROM media m
      JOIN media_tags mt ON mt.media_id = m.id
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE mt.tag LIKE ? AND mt.language = 'en'
      LIMIT 8
    `).all(`%${tag}%`);
    addCandidates(candidates, byTag, `tag_en: ${tag}`, 5);

    // EN description match (2x)
    const byDesc = db.prepare(`
      SELECT ${MEDIA_FIELDS} FROM media m
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE ma.description_en LIKE ?
      LIMIT 5
    `).all(`%${tag}%`);
    addCandidates(candidates, byDesc, `desc_en: ${tag}`, 10);
  }

  // --- 3. Visual description keywords → search in description ---
  if (scene.visual_description) {
    // Extract meaningful words (>3 chars, skip common words)
    const stopWords = new Set(['это', 'что', 'как', 'для', 'или', 'при', 'они', 'его', 'где', 'the', 'and', 'for', 'with']);
    const words = scene.visual_description
      .toLowerCase()
      .replace(/[^\wа-яёА-ЯЁ\s]/g, '')
      .split(/\s+/)
      .filter(w => w.length > 3 && !stopWords.has(w));

    const uniqueWords = [...new Set(words)].slice(0, 6);
    for (const word of uniqueWords) {
      const byDesc = db.prepare(`
        SELECT ${MEDIA_FIELDS} FROM media m
        JOIN media_analysis ma ON ma.media_id = m.id
        WHERE ma.description_ru LIKE ? OR ma.description_en LIKE ?
        LIMIT 3
      `).all(`%${word}%`, `%${word}%`);
      addCandidates(candidates, byDesc, `visual: ${word}`, 4);
    }
  }

  // --- 3b. Location hierarchy fallback search ---
  if (locationConfig) {
    for (const fallback of locationConfig.fallbacks) {
      // Check if we already have enough good candidates
      const currentBest = candidates.reduce((max, c) => Math.max(max, c.score), 0);
      if (currentBest >= 15) break; // good enough — stop fallback

      const byFallback = db.prepare(`
        SELECT DISTINCT ${MEDIA_FIELDS} FROM media m
        LEFT JOIN media_tags mt ON mt.media_id = m.id
        JOIN media_analysis ma ON ma.media_id = m.id
        WHERE mt.tag LIKE ? OR ma.description_ru LIKE ?
        LIMIT 5
      `).all(`%${fallback}%`, `%${fallback}%`);
      addCandidates(candidates, byFallback, `location_fallback: ${fallback}`, 6);
    }
  }

  // --- 3c. Document type search (newspapers, posters, leaflets) ---
  const docWords = /газет|плакат|листовк|лозунг|пропаганд|победы|агитаци|печат/i;
  if (docWords.test(scene.narration || '') || docWords.test(scene.visual_description || '')) {
    const byDocType = db.prepare(`
      SELECT ${MEDIA_FIELDS} FROM media m
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE ma.document_type IN ('газета', 'плакат', 'листовка', 'приказ')
      LIMIT 10
    `).all();
    addCandidates(candidates, byDocType, 'doc_type_match', 30);
  }

  // --- 4. Historical period ---
  if (scene.search_period) {
    const byPeriod = db.prepare(`
      SELECT ${MEDIA_FIELDS} FROM media m
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE ma.historical_period = ?
      LIMIT 10
    `).all(scene.search_period);
    addCandidates(candidates, byPeriod, `period: ${scene.search_period}`, 3);
  }

  // --- 5. Boost: shot_type match ---
  if (scene.preferred_shot_type) {
    for (const c of candidates) {
      if (c.shot_type === scene.preferred_shot_type) c.score += 3;
    }
  }

  // --- Deduplicate, rank, return top 5 ---
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

// --- Filtering rules: reject unsuitable photos ---

function parseYearFromText(text) {
  const match = text.match(/\b(1[89]\d{2}|20[0-2]\d)\b/);
  return match ? parseInt(match[1]) : null;
}

function parseYearRange(yearStr) {
  if (!yearStr) return null;
  const rangeMatch = yearStr.match(/(\d{4})\s*[-–]\s*(\d{4})/);
  if (rangeMatch) return { min: parseInt(rangeMatch[1]), max: parseInt(rangeMatch[2]) };
  const singleMatch = yearStr.match(/(\d{4})/);
  if (singleMatch) { const y = parseInt(singleMatch[1]); return { min: y, max: y }; }
  return null;
}

function filterPhotosForScene(photos, scene, globalContext = {}) {
  const db = getDb();
  const narration = (scene.narration || '').toLowerCase();
  const searchPersons = scene.search_persons || [];
  const mainPersons = globalContext.main_persons || [];
  const globalPeriod = parseYearRange(globalContext.period);
  const sceneLocation = scene.search_location || scene.visual_description || '';
  const locationConfig = findLocationConfig(sceneLocation);

  return photos.filter(photo => {
    const analysis = db.prepare(
      'SELECT persons, persons_count, is_memorial, year_estimate FROM media_analysis WHERE media_id = ?'
    ).get(photo.media_id);
    if (!analysis) return true;

    // Rule 1: "забыт/неизвестен/в тени" → ban memorials
    const shadowWords = /забыт|неизвестен|в тени|незаслуженно|безвестн/;
    if (shadowWords.test(narration) && analysis.is_memorial) {
      photo._rejected = 'memorial_in_shadow_context';
      return false;
    }

    // Rule 2: single person → prefer 1-2 people
    if (searchPersons.length === 1 && analysis.persons_count) {
      const count = analysis.persons_count === 'много' ? 10 : parseInt(analysis.persons_count) || 0;
      if (count > 3) {
        photo.score -= 8;
        photo.match_reasons.push('penalty: too_many_persons');
      }
    }

    // Rule 3: year in narration → ±5 years
    const textYear = parseYearFromText(scene.narration || '');
    if (textYear) {
      const photoYear = parseYearRange(analysis.year_estimate);
      if (photoYear) {
        const closest = textYear < photoYear.min ? photoYear.min : textYear > photoYear.max ? photoYear.max : textYear;
        const diff = Math.abs(textYear - closest);
        if (diff > 5) {
          photo.score -= diff * 2;
          photo.match_reasons.push(`penalty: year_diff_${diff}`);
        } else if (diff === 0) {
          photo.score += 5;
          photo.match_reasons.push('bonus: year_exact');
        }
      }
    }

    // Rule 4 (NEW): GLOBAL — photo year must be within global period ±3 years
    if (globalPeriod) {
      const photoYear = parseYearRange(analysis.year_estimate);
      if (photoYear) {
        const tooEarly = photoYear.max < globalPeriod.min - 3;
        const tooLate = photoYear.min > globalPeriod.max + 3;
        if (tooEarly || tooLate) {
          photo.score = -999;
          photo.match_reasons.push(`ban: year_outside_period (photo=${analysis.year_estimate}, period=${globalContext.period})`);
          return false;
        }
      }
    }

    // Rule 5 (NEW): GLOBAL — ban photos with persons NOT in main_persons
    if (mainPersons.length > 0 && analysis.persons) {
      try {
        const photoPersons = JSON.parse(analysis.persons)
          .map(p => p.name)
          .filter(n => n && !n.startsWith('Неизвестный'));

        if (photoPersons.length > 0) {
          const allMatch = photoPersons.every(pp =>
            mainPersons.some(mp => pp.includes(mp) || mp.includes(pp))
          );
          if (allMatch) {
            photo.score += 20;
            photo.match_reasons.push('bonus: all_persons_match_global');
          } else {
            const foreignPerson = photoPersons.find(pp =>
              !mainPersons.some(mp => pp.includes(mp) || mp.includes(pp))
            );
            if (foreignPerson) {
              photo.score = -999;
              photo.match_reasons.push(`ban: foreign_person (${foreignPerson} not in [${mainPersons.join(',')}])`);
              return false;
            }
          }
        }
      } catch {}
    }

    // Rule 6 (NEW): Location ban tags
    if (locationConfig && locationConfig.ban_tags.length > 0) {
      const photoTags = db.prepare(
        "SELECT tag FROM media_tags WHERE media_id = ? AND language = 'ru'"
      ).all(photo.media_id).map(t => t.tag.toLowerCase());

      for (const banned of locationConfig.ban_tags) {
        if (photoTags.some(t => t.includes(banned.toLowerCase()))) {
          photo.score -= 15;
          photo.match_reasons.push(`penalty: banned_tag_for_location (${banned})`);
        }
      }
    }

    return true;
  })
  .sort((a, b) => b.score - a.score)
  .slice(0, 5);
}

// --- Fallback: portrait of the hero when no photos matched ---

function findFallbackPortrait(scene, globalContext) {
  const db = getDb();
  const mainHero = globalContext.main_hero || null;
  const mainPersons = globalContext.main_persons || [];
  const narration = (scene.narration || '').toLowerCase();
  const sceneNum = scene.scene_number || 0;

  // Build priority list: narration mention → main_hero → other main_persons
  const candidates = [];

  // 1. Person mentioned in this scene's narration
  for (const person of mainPersons) {
    if (narration.includes(person.toLowerCase())) {
      candidates.push(person);
    }
  }

  // 2. Main hero (always available as fallback)
  if (mainHero && !candidates.includes(mainHero)) {
    candidates.push(mainHero);
  }

  // 3. Other main_persons
  for (const person of mainPersons) {
    if (!candidates.includes(person)) {
      candidates.push(person);
    }
  }

  // Try each candidate until we find photos
  for (const targetPerson of candidates) {
    const photos = db.prepare(`
      SELECT m.id, m.filename, m.thumbnail, ma.description_ru, ma.year_estimate,
             ma.historical_period, ma.persons, ma.person_positions
      FROM media m
      JOIN media_analysis ma ON ma.media_id = m.id
      WHERE ma.persons LIKE ?
      ORDER BY m.created_at
    `).all(`%${targetPerson}%`);

    if (photos.length === 0) continue;

    const picked = photos[sceneNum % photos.length];
    const isHero = targetPerson === mainHero;

    console.log(`      Fallback portrait: ${targetPerson}${isHero ? ' (MAIN HERO)' : ''} (photo ${(sceneNum % photos.length) + 1}/${photos.length})`);

    return {
      media_id: picked.id,
      filename: picked.filename,
      thumbnail: picked.thumbnail,
      description: picked.description_ru,
      year: picked.year_estimate,
      period: picked.historical_period,
      score: 0,
      match_reasons: [`fallback_portrait: ${targetPerson}${isHero ? ' (hero)' : ''}`],
      is_fallback_portrait: true,
      fallback_person: targetPerson,
    };
  }

  return null;
}

// --- Ken Burns rotation by scene number ---

const KB_ROTATION = [
  'zoom_in_center',       // 0 — медленное приближение
  'pan_left_to_right',    // 1 — панорама →
  'dramatic_push',        // 2 — резкое приближение
  'zoom_out',             // 3 — отдаление
  'pan_right_to_left',    // 4 — ← панорама
  'zoom_in_person',       // 5 — приближение к лицу
];

function getRotatedMovement(sceneNumber) {
  return KB_ROTATION[sceneNumber % KB_ROTATION.length];
}

function getSceneDuration(baseDuration, sceneNumber) {
  // Even scenes — slow (1.2x), odd — normal
  return sceneNumber % 2 === 0 ? baseDuration * 1.2 : baseDuration;
}

// --- Main pipeline ---

async function buildStoryboard(audioPath, context) {
  console.log('  [1/4] Transcribing audio...');
  const transcription = await transcribeAudio(audioPath);
  console.log(`    Transcription: ${transcription.text.length} chars, ${transcription.duration?.toFixed(1)}s`);

  console.log('  [2/4] Analyzing full transcription...');
  const globalContext = await analyzeFullTranscription(transcription);
  console.log(`    Main hero: ${globalContext.main_hero || '?'}`);
  console.log(`    Persons: ${globalContext.main_persons?.join(', ') || 'none'}`);
  console.log(`    Period: ${globalContext.period || '?'}`);
  console.log(`    Locations: ${globalContext.locations?.join(', ') || 'none'}`);

  console.log('  [3/4] Splitting into scenes...');
  const sceneData = await splitIntoScenes(transcription, context);
  console.log(`    Generated ${sceneData.scenes.length} scenes`);

  console.log('  [4/4] Matching photos (with global context filtering)...');
  const scenes = sceneData.scenes.map(scene => {
    const rawPhotos = findPhotosForScene(scene, globalContext);
    const photos = filterPhotosForScene(rawPhotos, scene, globalContext);
    const rejected = rawPhotos.length - photos.length;
    const bannedCount = rawPhotos.filter(p => p.score === -999).length;

    let selectedPhoto = photos[0] || null;
    let usedFallback = false;

    // Fallback: if no photos matched OR best score too low
    const bestScore = selectedPhoto?.score || 0;
    if (!selectedPhoto || bestScore < 20) {
      const fallback = findFallbackPortrait(scene, globalContext);
      if (fallback) {
        if (!selectedPhoto) {
          // No photos at all — use fallback
          selectedPhoto = fallback;
          usedFallback = true;
          photos.unshift(fallback);
        } else if (bestScore < 20) {
          // Weak match — fallback is better
          console.log(`      Weak match (score=${bestScore}), using fallback portrait instead`);
          selectedPhoto = fallback;
          usedFallback = true;
          photos.unshift(fallback);
        }
      }
    }

    // Ken Burns rotation + duration adjustment
    const sceneNum = scene.scene_number || 0;
    const kbMovement = getRotatedMovement(sceneNum);
    const baseDuration = scene.end_time - scene.start_time;
    const adjustedDuration = getSceneDuration(baseDuration, sceneNum);

    const logParts = [`${photos.length} candidates`];
    if (rejected) logParts.push(`${rejected} filtered`);
    if (bannedCount) logParts.push(`${bannedCount} banned`);
    if (usedFallback) logParts.push('FALLBACK portrait');
    logParts.push(`KB: ${kbMovement}`);
    console.log(`    Scene ${sceneNum}: ${logParts.join(', ')}`);

    return {
      ...scene,
      matched_photos: photos,
      selected_photo: selectedPhoto,
      is_fallback_portrait: usedFallback,
      kb_movement: kbMovement,
      adjusted_duration: adjustedDuration,
    };
  });

  return {
    title: sceneData.title,
    transcription,
    globalContext,
    scenes,
    context,
  };
}

module.exports = {
  transcribeAudio, splitIntoScenes, findPhotosForScene,
  findFallbackPortrait, getRotatedMovement, getSceneDuration,
  buildStoryboard, KB_ROTATION, LOCATION_HIERARCHY,
};
