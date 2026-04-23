const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { getDb } = require('../database');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ANALYSIS_PROMPT = `Ты — эксперт-историк и архивист, специализирующийся на советской и российской истории.
Проанализируй это изображение. Это может быть фотография, газета, плакат, приказ, список, удостоверение или другой исторический документ.
Верни JSON (без markdown-обёртки, только чистый JSON).

Структура ответа:
{
  "document_type": "один из: фото|газета|плакат|приказ|список|удостоверение|письмо|карта|схема|чертёж|другой документ",
  "persons": [
    { "name": "Имя Фамилия", "role": "описание роли/должности", "confidence": "high|medium|low" }
  ],
  "year_estimate": "год или диапазон, например 1943 или 1941-1945",
  "event": "название события или контекст",
  "location": "место съёмки или издания",
  "country": "страна",
  "era": "эпоха (например: СССР, Российская Империя, современная Россия)",
  "historical_period": "один из: революция|гражданская война|НЭП|индустриализация|ВОВ|послевоенный|оттепель|застой|перестройка|другое",
  "mood": "настроение снимка или тональность документа",
  "shot_type": "один из: портрет|группа|панорама|деталь|репортаж|документ",
  "setting": "один из: военная|гражданская|смешанная",
  "military_equipment": {
    "present": true/false,
    "types": ["танки", "самолёты", "корабли", "артиллерия", "стрелковое оружие"]
  },
  "uniforms": {
    "present": true/false,
    "description": "описание формы и знаков различия"
  },
  "photo_nature": "один из: документальное|постановочное|пропагандистское|художественное|официальное",
  "quality": "один из: отличное|хорошее|удовлетворительное|плохое",
  "preservation": "один из: отличная|хорошая|удовлетворительная|плохая",

  "document_text": "ПОЛНЫЙ текст, видимый на изображении — OCR. Сохраняй оригинальную орфографию, переносы строк, заголовки. Если текста нет — null",
  "document_info": {
    "publication_name": "название газеты/издания (например: Правда, Известия) или null",
    "document_number": "номер документа/приказа/выпуска или null",
    "document_date": "дата на документе (как написана) или null",
    "signatures": ["список подписей (ФИО подписавших)"],
    "stamps_seals": ["описание печатей и штампов"],
    "classification": "гриф секретности: секретно|совершенно секретно|для служебного пользования|без грифа|null",
    "organizations": ["упомянутые организации: НКВД, ОГПУ, ЦК ВКП(б), Совнарком, ГКО, Наркомат, РККА и т.д."],
    "addressee": "кому адресован документ или null",
    "author": "автор/отправитель документа или null"
  },

  "description_ru": "Подробное описание на русском (2-3 предложения)",
  "description_en": "Detailed description in English (2-3 sentences)",
  "tags_ru": ["тег1", "тег2", "тег3", "...до 15 тегов на русском"],
  "tags_en": ["tag1", "tag2", "tag3", "...up to 15 tags in English"]
}

Если что-то невозможно определить — ставь null. Теги должны быть конкретными и полезными для поиска.
Для документов ОБЯЗАТЕЛЬНО извлеки весь читаемый текст в document_text — это критически важно для архива.`;

const sharp = require('sharp');

// Formats Claude Vision accepts natively
const NATIVE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function getMimeType(filepath) {
  const ext = path.extname(filepath).toLowerCase();
  const map = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp',
    '.bmp': 'image/bmp', '.tiff': 'image/tiff',
    '.avif': 'image/avif', '.heif': 'image/heif', '.heic': 'image/heic',
  };
  return map[ext] || 'image/jpeg';
}

async function prepareImageForVision(filepath) {
  const mimeType = getMimeType(filepath);

  // Claude Vision supports JPEG, PNG, WebP, GIF natively
  // Convert AVIF, HEIF, HEIC, BMP, TIFF → JPEG
  if (!NATIVE_MIMES.has(mimeType)) {
    const buffer = await sharp(filepath).jpeg({ quality: 90 }).toBuffer();
    return { base64: buffer.toString('base64'), mimeType: 'image/jpeg' };
  }

  const buffer = fs.readFileSync(filepath);
  return { base64: buffer.toString('base64'), mimeType };
}

async function analyzePhoto(filepath, filename) {
  const { base64, mimeType } = await prepareImageForVision(filepath);

  console.log(`    Analyzing with Claude Vision: ${filename}`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 4000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mimeType, data: base64 },
          },
          {
            type: 'text',
            text: `Файл: ${filename}\n\n${ANALYSIS_PROMPT}`,
          },
        ],
      },
    ],
  });

  const text = response.content[0].text.trim();

  // Parse JSON — handle possible markdown wrapping
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) {
      json = JSON.parse(match[1].trim());
    } else {
      throw new Error(`Failed to parse Claude response as JSON: ${text.slice(0, 200)}`);
    }
  }

  return json;
}

function saveAnalysis(mediaId, analysis) {
  const db = getDb();

  db.prepare(`
    INSERT OR REPLACE INTO media_analysis (
      media_id, document_type, persons, year_estimate, event, location, country, era,
      historical_period, mood, shot_type, setting,
      military_equipment, uniforms, photo_nature,
      quality, preservation, description_ru, description_en,
      document_text, document_info,
      raw_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    mediaId,
    analysis.document_type,
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

module.exports = { analyzePhoto, saveAnalysis };
