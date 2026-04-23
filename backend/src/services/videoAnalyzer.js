const fs = require('fs');
const path = require('path');
const ffmpeg = require('fluent-ffmpeg');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../database');

ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH || '/opt/homebrew/bin/ffmpeg');
ffmpeg.setFfprobePath(process.env.FFPROBE_PATH || '/opt/homebrew/bin/ffprobe');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const FRAMES_DIR = path.resolve(process.env.TEMP_DIR || './temp', 'frames');

const FRAME_PROMPT = `Ты — эксперт-историк и архивист. Проанализируй этот кадр из видео.
Верни JSON (без markdown-обёртки, только чистый JSON):
{
  "persons": [{ "name": "Имя Фамилия", "role": "роль", "confidence": "high|medium|low" }],
  "year_estimate": "год или диапазон",
  "event": "событие",
  "location": "место",
  "setting": "военная|гражданская|смешанная",
  "military_equipment": { "present": true/false, "types": [] },
  "uniforms": { "present": true/false, "description": "" },
  "document_text": "видимый текст (OCR) или null",
  "scene_description": "что происходит в кадре (1-2 предложения)",
  "tags_ru": ["до 10 тегов"],
  "tags_en": ["up to 10 tags"]
}
Если что-то невозможно определить — null.`;

const MERGE_PROMPT = `Ты — эксперт-историк и архивист. Тебе даны результаты покадрового анализа видео.
Объедини их в ОДИН итоговый анализ всего видео. Убери дубли, обобщи, выбери наиболее точные данные.
Верни JSON (без markdown-обёртки):
{
  "document_type": "видео",
  "persons": [{ "name": "Имя Фамилия", "role": "роль", "confidence": "high|medium|low" }],
  "year_estimate": "год или диапазон",
  "event": "событие",
  "location": "место",
  "country": "страна",
  "era": "эпоха",
  "historical_period": "революция|гражданская война|НЭП|индустриализация|ВОВ|послевоенный|оттепель|застой|перестройка|другое",
  "mood": "настроение",
  "shot_type": "репортаж|документ|хроника|другое",
  "setting": "военная|гражданская|смешанная",
  "military_equipment": { "present": true/false, "types": [] },
  "uniforms": { "present": true/false, "description": "" },
  "photo_nature": "документальное|постановочное|пропагандистское|художественное|официальное",
  "quality": "отличное|хорошее|удовлетворительное|плохое",
  "preservation": "отличная|хорошая|удовлетворительная|плохая",
  "document_text": "весь текст из всех кадров, объединённый, или null",
  "document_info": {
    "publication_name": null,
    "document_number": null,
    "document_date": null,
    "signatures": [],
    "stamps_seals": [],
    "classification": null,
    "organizations": [],
    "addressee": null,
    "author": null
  },
  "description_ru": "Описание видео на русском (3-4 предложения, охватывающие всё содержание)",
  "description_en": "Video description in English (3-4 sentences covering all content)",
  "tags_ru": ["до 20 тегов на русском — объединить из всех кадров, убрать дубли"],
  "tags_en": ["up to 20 tags in English — merged from all frames, deduplicated"]
}`;

function extractFrames(videoPath, intervalSec = 5) {
  return new Promise((resolve, reject) => {
    const videoId = path.basename(videoPath, path.extname(videoPath));
    const outDir = path.join(FRAMES_DIR, videoId);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

    ffmpeg(videoPath)
      .outputOptions([`-vf fps=1/${intervalSec}`, '-q:v 2'])
      .output(path.join(outDir, 'frame_%04d.jpg'))
      .on('end', () => {
        const frames = fs.readdirSync(outDir)
          .filter(f => f.endsWith('.jpg'))
          .sort()
          .map(f => path.join(outDir, f));
        console.log(`    Extracted ${frames.length} frames (every ${intervalSec}s)`);
        resolve({ frames, outDir });
      })
      .on('error', reject)
      .run();
  });
}

async function analyzeFrame(framePath, frameIndex, totalFrames, filename) {
  const buffer = fs.readFileSync(framePath);
  const base64 = buffer.toString('base64');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
          },
          {
            type: 'text',
            text: `Видео: ${filename}, кадр ${frameIndex + 1}/${totalFrames}\n\n${FRAME_PROMPT}`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1].trim());
    throw new Error(`Failed to parse frame analysis: ${text.slice(0, 200)}`);
  }
}

async function mergeFrameAnalyses(frameResults, filename) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: `Видео: ${filename}\nРезультаты анализа ${frameResults.length} кадров:\n\n${JSON.stringify(frameResults, null, 2)}\n\n${MERGE_PROMPT}`,
      },
    ],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1].trim());
    throw new Error(`Failed to parse merged analysis: ${text.slice(0, 200)}`);
  }
}

async function analyzeVideo(videoPath, filename) {
  console.log(`    Extracting frames from: ${filename}`);
  const { frames, outDir } = await extractFrames(videoPath);

  if (frames.length === 0) {
    throw new Error('No frames extracted from video');
  }

  // Limit to max 20 frames to control API costs
  const maxFrames = 20;
  let selectedFrames = frames;
  if (frames.length > maxFrames) {
    const step = Math.floor(frames.length / maxFrames);
    selectedFrames = frames.filter((_, i) => i % step === 0).slice(0, maxFrames);
    console.log(`    Sampling ${selectedFrames.length} of ${frames.length} frames`);
  }

  // Analyze each frame
  const frameResults = [];
  for (let i = 0; i < selectedFrames.length; i++) {
    console.log(`    Analyzing frame ${i + 1}/${selectedFrames.length}`);
    try {
      const result = await analyzeFrame(selectedFrames[i], i, selectedFrames.length, filename);
      frameResults.push(result);
    } catch (err) {
      console.warn(`    Frame ${i + 1} analysis failed: ${err.message}`);
    }
  }

  // Clean up frames
  try {
    fs.rmSync(outDir, { recursive: true });
  } catch {}

  if (frameResults.length === 0) {
    throw new Error('All frame analyses failed');
  }

  // Merge results
  console.log(`    Merging ${frameResults.length} frame analyses...`);
  const merged = await mergeFrameAnalyses(frameResults, filename);
  merged.frames_analyzed = frameResults.length;
  merged.document_type = 'видео';

  return merged;
}

function saveVideoAnalysis(mediaId, analysis) {
  const db = getDb();

  db.prepare(`
    INSERT OR REPLACE INTO media_analysis (
      media_id, document_type, persons, year_estimate, event, location, country, era,
      historical_period, mood, shot_type, setting,
      military_equipment, uniforms, photo_nature,
      quality, preservation, description_ru, description_en,
      document_text, document_info, frames_analyzed,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mediaId,
    analysis.document_type || 'видео',
    JSON.stringify(analysis.persons || []),
    analysis.year_estimate,
    analysis.event,
    analysis.location,
    analysis.country,
    analysis.era,
    analysis.historical_period,
    analysis.mood,
    analysis.shot_type,
    analysis.setting,
    JSON.stringify(analysis.military_equipment || {}),
    JSON.stringify(analysis.uniforms || {}),
    analysis.photo_nature,
    analysis.quality,
    analysis.preservation,
    analysis.description_ru,
    analysis.description_en,
    analysis.document_text,
    JSON.stringify(analysis.document_info || {}),
    analysis.frames_analyzed,
    JSON.stringify(analysis)
  );

  // Save tags
  const deleteTags = db.prepare('DELETE FROM media_tags WHERE media_id = ?');
  const insertTag = db.prepare(
    'INSERT INTO media_tags (media_id, tag, language) VALUES (?, ?, ?)'
  );

  const saveTags = db.transaction((mediaId, tagsRu, tagsEn) => {
    deleteTags.run(mediaId);
    for (const tag of tagsRu || []) {
      insertTag.run(mediaId, tag, 'ru');
    }
    for (const tag of tagsEn || []) {
      insertTag.run(mediaId, tag, 'en');
    }
  });

  saveTags(mediaId, analysis.tags_ru, analysis.tags_en);
}

module.exports = { analyzeVideo, saveVideoAnalysis, extractFrames };
