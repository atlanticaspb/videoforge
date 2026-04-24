// Film effect filters for ffmpeg — each function returns a filter string or filter complex segment.
// intensity: 0.0 (off) to 1.0 (max)

const path = require('path');

const ASSETS_DIR = path.resolve(__dirname, '../../assets/overlays');

// --- Individual effects ---

function filmGrain(intensity = 0.5) {
  // noise filter: alls=enable for all frames, allf=temporal for flicker
  const amount = Math.round(intensity * 40 + 5); // 5–45
  const flags = intensity > 0.6 ? 'a+t' : 'a';
  return `noise=c0s=${amount}:c0f=${flags}`;
}

function sepia() {
  // Warm sepia tone via colorchannelmixer
  return 'colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0';
}

function vignette(intensity = 0.5) {
  // angle controls how far the darkening extends — PI/4 is moderate, PI/2 is extreme
  const angle = (intensity * 0.6 + 0.2).toFixed(2); // 0.2–0.8 of PI
  return `vignette=angle=${angle}*PI`;
}

function flicker(intensity = 0.5) {
  // Simulate brightness flicker via random per-frame luma adjustment
  const range = (intensity * 0.08 + 0.02).toFixed(3); // 0.02–0.10
  return `eq=brightness='0.02*sin(random(1)*${Math.PI * 2})*(${range}/${0.05})':eval=frame`;
}

function verticalScratches(intensity = 0.5) {
  // Draw random thin white vertical lines — simulate film scratches
  // Uses geq (generic equation) filter for procedural generation
  const opacity = (intensity * 0.3 + 0.05).toFixed(2);
  const numLines = Math.round(intensity * 4 + 1); // 1–5 scratch lines
  // Build scratch expression: bright vertical lines at pseudo-random X positions
  const scratches = [];
  for (let i = 0; i < numLines; i++) {
    const seed = (i * 137 + 43) % 256; // deterministic pseudo-random
    scratches.push(`lt(abs(mod(X+${seed}*T,W)-W*${((i + 1) / (numLines + 1)).toFixed(3)}),1)`);
  }
  const expr = scratches.join('+');
  return `geq=lum='lum(X,Y)+255*${opacity}*(${expr})':cb='cb(X,Y)':cr='cr(X,Y)'`;
}

function filmBurn(intensity = 0.5) {
  // White flash with soft edge — simulate film melting/burning
  // Radial gradient bright spot that moves
  const brightness = (intensity * 0.4 + 0.1).toFixed(2);
  const radius = (intensity * 0.3 + 0.1).toFixed(2);
  return [
    `geq=lum='clip(lum(X,Y)+255*${brightness}*exp(-((X-W*abs(sin(T*0.7)))*(X-W*abs(sin(T*0.7)))+(Y-H*0.3)*(Y-H*0.3))/(2*pow(W*${radius},2))),0,255)':cb='cb(X,Y)':cr='cr(X,Y)'`,
  ].join(',');
}

function lightLeak(intensity = 0.5) {
  // Warm colored light leak — orange/amber glow from edge
  const strength = (intensity * 60 + 10).toFixed(0); // 10–70
  return [
    `split[ll_main][ll_leak]`,
    `[ll_leak]colorbalance=rs=0.3:gs=0.1:bs=-0.1,` +
    `geq=lum='clip(lum(X,Y)*exp(-pow((X-W*0.8),2)/(2*pow(W*0.4,2))),0,255)':cb='cb(X,Y)':cr='cr(X,Y)',` +
    `format=yuva420p,colorchannelmixer=aa=${(intensity * 0.4 + 0.1).toFixed(2)}[ll_overlay]`,
    `[ll_main][ll_overlay]overlay=format=auto`,
  ];
}

function frameJitter(intensity = 0.5) {
  // Random X/Y displacement per frame — simulate unstable gate
  const maxShift = Math.round(intensity * 6 + 1); // 1–7 pixels
  return `crop=iw-${maxShift * 2}:ih-${maxShift * 2}:` +
    `'${maxShift}+${maxShift}*random(1)':'${maxShift}+${maxShift}*random(2)',` +
    `scale=iw+${maxShift * 2}:ih+${maxShift * 2}`;
}

function countdownLeader(fps = 24) {
  // Generate 5-second countdown: 5,4,3,2,1 — each number displayed for 1 second
  // Returns a filter complex that generates the countdown and prepends it
  const segments = [];
  for (let n = 5; n >= 1; n--) {
    segments.push(
      `color=c=black:s=1920x1080:d=1:r=${fps}[cd_bg${n}]`,
      `[cd_bg${n}]drawtext=text='${n}':fontsize=300:fontcolor=white:x=(w-text_w)/2:y=(h-text_h)/2:` +
      `font=monospace,` +
      // Circle sweep using drawbox as approximation
      `drawbox=x=iw/2-200:y=ih/2-200:w=400:h=400:color=white@0.3:t=3,` +
      // Add film grain to countdown
      `noise=c0s=30:c0f=a+t,` +
      // Sepia tone
      `colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131:0` +
      `[cd_num${n}]`
    );
  }

  const concatInputs = [5, 4, 3, 2, 1].map(n => `[cd_num${n}]`).join('');
  segments.push(`${concatInputs}concat=n=5:v=1:a=0[countdown]`);

  return {
    filters: segments,
    outputLabel: '[countdown]',
    duration: 5,
  };
}

function reelChange(intensity = 0.5) {
  // Small circle in top-right corner — reel change cue mark
  const size = Math.round(intensity * 20 + 10); // 10–30 px radius
  return `drawbox=x=iw-${size * 3}:y=${size}:w=${size * 2}:h=${size * 2}:color=white@0.8:t=fill:enable='between(mod(t,30),29,30)'`;
}

function spliceMark(intensity = 0.5) {
  // Horizontal bright band — simulates physical film splice
  const height = Math.round(intensity * 15 + 3); // 3–18 px
  const interval = Math.round(20 - intensity * 10); // every 10–20 sec
  return `drawbox=x=0:y=ih/2-${Math.round(height / 2)}:w=iw:h=${height}:color=white@0.7:t=fill:enable='between(mod(t,${interval}),0,0.15)'`;
}

// --- Style presets ---

function applyFilmStyle(style, intensity = 0.7) {
  const i = Math.max(0, Math.min(1, intensity));

  const presets = {
    chronicle: {
      description: 'Soviet newsreel look — heavy grain, scratches, flicker, sepia',
      filters: [
        sepia(),
        filmGrain(i * 1.0),
        verticalScratches(i * 0.9),
        flicker(i * 0.8),
        vignette(i * 0.5),
        frameJitter(i * 0.6),
        reelChange(i),
        spliceMark(i * 0.5),
      ],
    },

    documentary: {
      description: 'Clean documentary — light grain, subtle vignette',
      filters: [
        filmGrain(i * 0.3),
        vignette(i * 0.4),
      ],
    },

    dramatic: {
      description: 'Dramatic archival — film burn, shake, heavy vignette',
      filters: [
        filmGrain(i * 0.5),
        filmBurn(i * 0.7),
        frameJitter(i * 0.8),
        vignette(i * 0.9),
        flicker(i * 0.4),
      ],
    },

    archive: {
      description: 'Degraded archive footage — sepia, heavy scratches, countdown',
      filters: [
        sepia(),
        filmGrain(i * 0.8),
        verticalScratches(i * 1.0),
        vignette(i * 0.6),
        spliceMark(i * 0.8),
        reelChange(i * 0.7),
      ],
      countdown: true,
    },
  };

  const preset = presets[style];
  if (!preset) {
    throw new Error(`Unknown style: ${style}. Available: ${Object.keys(presets).join(', ')}`);
  }

  return preset;
}

function buildFilterChain(style, intensity = 0.7) {
  const preset = applyFilmStyle(style, intensity);

  // lightLeak returns an array (filter_complex segments), others return strings
  const simpleFilters = preset.filters.filter(f => typeof f === 'string');
  const chain = simpleFilters.join(',');

  return {
    filterString: chain,
    description: preset.description,
    countdown: preset.countdown || false,
    countdownData: preset.countdown ? countdownLeader() : null,
  };
}

// --- Mood-based color grading ---

function colorGrade(mood) {
  const grades = {
    'тревожное': {
      // Red-orange alarming tone: boost reds, crush shadows warm
      filter: 'eq=saturation=0.7:contrast=1.1,colorbalance=rs=0.3:gs=-0.1:bs=-0.2:rh=0.1:gh=-0.05:bh=-0.1',
      description: 'red-orange alarm',
    },
    'триумфальное': {
      // Golden warm tone: high contrast, warm highlights
      filter: 'eq=saturation=0.85:contrast=1.15:brightness=0.03,colorbalance=rs=0.15:gs=0.08:bs=-0.1:rh=0.1:gh=0.05:bh=-0.05',
      description: 'golden triumph',
    },
    'трагическое': {
      // Cold blue desaturated: 40% desat + blue shadows
      filter: 'eq=saturation=0.6:contrast=1.05,colorbalance=rs=-0.15:gs=-0.05:bs=0.25:rh=-0.1:gh=0.0:bh=0.15',
      description: 'cold blue tragedy',
    },
    'мрачное': {
      // Dark desaturated with slight green
      filter: 'eq=saturation=0.65:contrast=1.1:brightness=-0.03,colorbalance=rs=-0.05:gs=0.05:bs=0.0:rh=-0.05:gh=0.0:bh=0.05',
      description: 'dark ominous',
    },
    'рабочее': {
      // Slightly green industrial tone
      filter: 'eq=saturation=0.8:contrast=1.05,colorbalance=rs=-0.05:gs=0.1:bs=-0.05:rh=-0.03:gh=0.05:bh=-0.03',
      description: 'industrial green',
    },
    'торжественное': {
      // Warm sepia-like but richer
      filter: 'eq=saturation=0.75:contrast=1.1,colorbalance=rs=0.1:gs=0.05:bs=-0.08:rh=0.05:gh=0.02:bh=-0.05',
      description: 'warm ceremonial',
    },
    'спокойное': {
      // Neutral warm
      filter: 'eq=saturation=0.85,colorbalance=rs=0.05:gs=0.02:bs=-0.03',
      description: 'neutral warm',
    },
  };

  const grade = grades[mood] || grades['спокойное'];
  return grade;
}

// --- Red dramatic background for fallback portraits ---

function redDramaticPortrait() {
  // Creates a cinematic red-tinted portrait:
  // 1. Convert photo to high-contrast B&W
  // 2. Overlay on dark red gradient background
  // 3. Heavy vignette
  return {
    // Process as filter_complex with split:
    // Input → B&W contrast → blend with red
    photoFilter: 'hue=s=0,eq=contrast=1.4:brightness=-0.05',
    // Red tint overlay via colorbalance on the B&W image
    redTint: 'colorbalance=rs=0.4:gs=-0.1:bs=-0.15:rm=0.3:gm=-0.05:bm=-0.1',
    // Heavy vignette
    vignetteFilter: 'vignette=angle=0.8*PI',
    // Combined single-chain filter
    combined: 'hue=s=0,eq=contrast=1.4:brightness=-0.05,colorbalance=rs=0.4:gs=-0.1:bs=-0.15:rm=0.3:gm=-0.05:bm=-0.1,vignette=angle=0.8*PI',
    description: 'red dramatic portrait',
  };
}

module.exports = {
  // Individual effects
  filmGrain,
  sepia,
  vignette,
  flicker,
  verticalScratches,
  filmBurn,
  lightLeak,
  frameJitter,
  countdownLeader,
  reelChange,
  spliceMark,
  // Color grading
  colorGrade,
  redDramaticPortrait,
  // Presets
  applyFilmStyle,
  buildFilterChain,
};
