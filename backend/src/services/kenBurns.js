const Anthropic = require('@anthropic-ai/sdk');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Output video dimensions
const OUT_W = 1920;
const OUT_H = 1080;

// --- Position mapping ---

function positionToCoords(pos) {
  // Convert person_positions {x: "left|center|right", y: "top|middle|bottom"}
  // to normalized coordinates 0.0–1.0
  const xMap = { left: 0.25, center: 0.5, right: 0.75 };
  const yMap = { top: 0.25, middle: 0.5, bottom: 0.75 };
  return {
    nx: xMap[pos?.x] ?? 0.5,
    ny: yMap[pos?.y] ?? 0.5,
  };
}

// --- Movement generators ---
// Each returns { z, x, y } expressions for ffmpeg zoompan filter.
// Variables available in zoompan expressions:
//   in_w, in_h = input dimensions
//   iw, ih = output dimensions (=OUT_W, OUT_H after scale)
//   on = output frame number (0-based)
//   outw, outh = zoompan output size (=OUT_W, OUT_H)
//   zoom = current zoom level
//   pzoom = previous zoom level

const movements = {
  zoom_in_center(duration, fps) {
    const totalFrames = Math.round(duration * fps);
    // Zoom from 1.0 to 1.4 — noticeable push
    return {
      z: `min(1+0.4*on/${totalFrames},1.4)`,
      x: `(iw/2)-(iw/zoom/2)`,
      y: `(ih/2)-(ih/zoom/2)`,
    };
  },

  zoom_in_person(duration, fps, targetX = 0.5, targetY = 0.5) {
    const totalFrames = Math.round(duration * fps);
    // Zoom to 1.6 toward the person — tight closeup
    return {
      z: `min(1+0.6*on/${totalFrames},1.6)`,
      x: `${targetX}*iw-(iw/zoom/2)`,
      y: `${targetY}*ih-(ih/zoom/2)`,
    };
  },

  pan_left_to_right(duration, fps) {
    const totalFrames = Math.round(duration * fps);
    // 1.3x zoom + pan 25% of frame width
    return {
      z: '1.3',
      x: `(iw*0.25)*on/${totalFrames}`,
      y: `(ih/2)-(ih/zoom/2)`,
    };
  },

  pan_right_to_left(duration, fps) {
    const totalFrames = Math.round(duration * fps);
    // 1.3x zoom + reverse pan 25%
    return {
      z: '1.3',
      x: `(iw*0.25)*(1-on/${totalFrames})`,
      y: `(ih/2)-(ih/zoom/2)`,
    };
  },

  zoom_out(duration, fps) {
    const totalFrames = Math.round(duration * fps);
    // Start zoomed in at 1.5, pull back to 1.0 — dramatic reveal
    return {
      z: `max(1.5-0.5*on/${totalFrames},1.0)`,
      x: `(iw/2)-(iw/zoom/2)`,
      y: `(ih/2)-(ih/zoom/2)`,
    };
  },

  dramatic_push(duration, fps, targetX = 0.5, targetY = 0.5) {
    const totalFrames = Math.round(duration * fps);
    // Aggressive zoom to 1.8 with cubic easing — punchy climax
    return {
      z: `min(1+0.8*pow(on/${totalFrames},2),1.8)`,
      x: `${targetX}*iw-(iw/zoom/2)`,
      y: `${targetY}*ih-(ih/zoom/2)`,
    };
  },
};

// --- Duration-aware filter builder ---

function buildDurationAwareFilter(movementType, duration, fps, targetX, targetY) {
  const totalFrames = Math.round(duration * fps);

  // Short scenes (< 4s): slow down movement to 0.7x speed
  if (duration < 4) {
    const slowDuration = duration / 0.7;
    const moveFn = movements[movementType];
    const params = moveFn(slowDuration, fps, targetX, targetY);
    return {
      filter: `zoompan=z='${params.z}':x='${params.x}':y='${params.y}':d=${totalFrames}:s=${OUT_W}x${OUT_H}:fps=${fps}`,
      compound: false,
    };
  }

  // Long scenes (> 8s): compound movement — zoom first half, then pan second half
  if (duration > 8) {
    const halfFrames = Math.round(totalFrames / 2);
    // First half: zoom_in_center
    const zoomEnd = 1.3;
    // Second half: hold zoom + pan right
    const panRange = 0.15; // 15% of frame
    const z = `if(lt(on,${halfFrames}),min(1+${zoomEnd - 1}*on/${halfFrames},${zoomEnd}),${zoomEnd})`;
    const x = `if(lt(on,${halfFrames}),(iw/2)-(iw/zoom/2),(iw/2)-(iw/zoom/2)+(iw*${panRange})*(on-${halfFrames})/${halfFrames})`;
    const y = `(ih/2)-(ih/zoom/2)`;
    return {
      filter: `zoompan=z='${z}':x='${x}':y='${y}':d=${totalFrames}:s=${OUT_W}x${OUT_H}:fps=${fps}`,
      compound: true,
    };
  }

  // Normal duration: standard movement
  const moveFn = movements[movementType];
  const params = moveFn(duration, fps, targetX, targetY);
  return {
    filter: `zoompan=z='${params.z}':x='${params.x}':y='${params.y}':d=${totalFrames}:s=${OUT_W}x${OUT_H}:fps=${fps}`,
    compound: false,
  };
}

// --- Smart movement selection ---

function smartKenBurns(photoAnalysis, duration, options = {}) {
  const fps = options.fps || 24;
  const movementType = options.movement || 'zoom_in_center';
  const targetPerson = options.targetPerson || null;

  let targetX = 0.5;
  let targetY = 0.5;

  // If targeting a specific person, use their position
  if (targetPerson && photoAnalysis?.person_positions) {
    const positions = typeof photoAnalysis.person_positions === 'string'
      ? JSON.parse(photoAnalysis.person_positions)
      : photoAnalysis.person_positions;

    const personPos = positions[targetPerson];
    if (personPos) {
      const coords = positionToCoords(personPos);
      targetX = coords.nx;
      targetY = coords.ny;
    }
  }

  // Get movement parameters
  const moveFn = movements[movementType];
  if (!moveFn) {
    throw new Error(`Unknown movement: ${movementType}. Available: ${Object.keys(movements).join(', ')}`);
  }

  const totalFrames = Math.round(duration * fps);

  // Use duration-aware builder for short/long scenes
  const { filter, compound } = buildDurationAwareFilter(movementType, duration, fps, targetX, targetY);

  return {
    filter,
    movement: movementType,
    compound,
    targetX,
    targetY,
    duration,
    fps,
    totalFrames,
  };
}

// --- Claude-based movement selection ---

async function selectMovement(sceneText, photoAnalysis) {
  const persons = photoAnalysis?.persons
    ? (typeof photoAnalysis.persons === 'string' ? JSON.parse(photoAnalysis.persons) : photoAnalysis.persons)
    : [];
  const positions = photoAnalysis?.person_positions
    ? (typeof photoAnalysis.person_positions === 'string' ? JSON.parse(photoAnalysis.person_positions) : photoAnalysis.person_positions)
    : {};
  const shotType = photoAnalysis?.shot_type || 'unknown';
  const setting = photoAnalysis?.setting || 'unknown';

  const prompt = `Ты — режиссёр монтажа документального фильма. Выбери тип движения камеры (Ken Burns эффект) для сцены.

ТЕКСТ СЦЕНЫ: "${sceneText}"

ФОТО:
- Тип кадра: ${shotType}
- Обстановка: ${setting}
- Персоны: ${persons.map(p => p.name).filter(Boolean).join(', ') || 'нет'}
- Позиции: ${JSON.stringify(positions)}
- Описание: ${photoAnalysis?.description_ru || 'нет'}

ДОСТУПНЫЕ ДВИЖЕНИЯ:
- zoom_in_center — плавное приближение к центру (универсальное, спокойные сцены)
- zoom_in_person — приближение к конкретному персонажу (когда упоминается человек)
- pan_left_to_right — панорама слева направо (обзорные кадры, панорамы, группы)
- pan_right_to_left — панорама справа налево (движение против направления чтения, тревога)
- zoom_out — отдаление, раскрытие масштаба (начало сцены, контекст)
- dramatic_push — резкое приближение (драматичные моменты, кульминация, шок)

Верни JSON (без обёртки):
{
  "movement": "тип_движения",
  "target_person": "Имя Фамилия или null — к кому приближаться",
  "reason": "почему выбрано это движение (1 предложение)"
}`;

  const response = await claude.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = response.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (match) return JSON.parse(match[1].trim());
    // Fallback
    return { movement: 'zoom_in_center', target_person: null, reason: 'fallback' };
  }
}

// --- Convenience: full pipeline for one scene ---

async function kenBurnsForScene(sceneText, photoAnalysis, duration, options = {}) {
  const fps = options.fps || 24;

  // Let Claude pick the best movement
  const decision = await selectMovement(sceneText, photoAnalysis);

  // Generate the filter
  const result = smartKenBurns(photoAnalysis, duration, {
    fps,
    movement: decision.movement,
    targetPerson: decision.target_person,
  });

  return {
    ...result,
    reason: decision.reason,
    target_person: decision.target_person,
  };
}

// --- Parallax effect: 2-layer depth illusion ---

function parallaxEffect(duration, fps = 24) {
  const totalFrames = Math.round(duration * fps);

  // filter_complex with two layers from a single input:
  // [0:v] → split into background (full, blurred, slow zoom) and foreground (center crop, sharp, faster zoom)
  // Then overlay foreground on background

  const bgZoom = `min(1+0.15*on/${totalFrames},1.15)`;    // slow: 1.0 → 1.15
  const fgZoom = `min(1+0.35*on/${totalFrames},1.35)`;    // fast: 1.0 → 1.35

  const filterComplex = [
    // Split input into bg and fg
    `split[par_bg][par_fg]`,
    // Background: full frame, blur, slow zoom
    `[par_bg]gblur=sigma=3,zoompan=z='${bgZoom}':x='(iw/2)-(iw/zoom/2)':y='(ih/2)-(ih/zoom/2)':d=${totalFrames}:s=${OUT_W}x${OUT_H}:fps=${fps}[bg_out]`,
    // Foreground: crop center 60%, sharp, faster zoom in opposite direction (slight left drift)
    `[par_fg]crop=iw*0.6:ih*0.6:iw*0.2:ih*0.2,scale=${OUT_W}:${OUT_H},zoompan=z='${fgZoom}':x='(iw/2)-(iw/zoom/2)+(iw*0.03*on/${totalFrames})':y='(ih/2)-(ih/zoom/2)':d=${totalFrames}:s=${OUT_W}x${OUT_H}:fps=${fps},format=yuva420p,colorchannelmixer=aa=0.85[fg_out]`,
    // Overlay foreground on background
    `[bg_out][fg_out]overlay=format=auto`,
  ].join(';');

  return {
    filterComplex,
    isComplex: true, // needs -filter_complex, not -vf
    duration,
    fps,
    totalFrames,
    movement: 'parallax',
  };
}

module.exports = {
  smartKenBurns,
  selectMovement,
  kenBurnsForScene,
  buildDurationAwareFilter,
  parallaxEffect,
  movements: Object.keys(movements),
};
