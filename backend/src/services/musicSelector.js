const fs = require('fs');
const path = require('path');

const MUSIC_DIR = path.resolve(process.env.MUSIC_DIR || './music');

// Mood prefixes in filenames: dramatic_epic.mp3, tense_chase.mp3, etc.
const MOOD_PREFIXES = {
  dramatic: ['dramatic_', 'drama_', 'epic_'],
  tense: ['tense_', 'tension_', 'suspense_', 'alarm_'],
  triumph: ['triumph_', 'victory_', 'heroic_', 'glory_'],
  neutral: ['neutral_', 'ambient_', 'calm_', 'background_'],
  sad: ['sad_', 'tragic_', 'melancholy_', 'sorrow_'],
  industrial: ['industrial_', 'factory_', 'machine_'],
  war: ['war_', 'battle_', 'military_', 'march_'],
};

// Map photo_mood → music mood category
const MOOD_MAP = {
  'тревожное': 'tense',
  'трагическое': 'sad',
  'торжественное': 'triumph',
  'триумфальное': 'triumph',
  'рабочее': 'neutral',
  'нейтральное': 'neutral',
  'спокойное': 'neutral',
  'мрачное': 'dramatic',
  'официальное': 'neutral',
  'индустриальное': 'industrial',
};

function listTracks() {
  if (!fs.existsSync(MUSIC_DIR)) return [];

  return fs.readdirSync(MUSIC_DIR)
    .filter(f => /\.(mp3|wav|ogg|m4a|aac|flac)$/i.test(f))
    .map(f => {
      const lower = f.toLowerCase();
      let mood = 'neutral';
      for (const [category, prefixes] of Object.entries(MOOD_PREFIXES)) {
        if (prefixes.some(p => lower.startsWith(p))) {
          mood = category;
          break;
        }
      }
      return {
        filename: f,
        path: path.join(MUSIC_DIR, f),
        mood,
        size: fs.statSync(path.join(MUSIC_DIR, f)).size,
      };
    });
}

function selectForProject(sceneMoods) {
  const tracks = listTracks();
  if (tracks.length === 0) return null;

  // Count predominant mood
  const moodCounts = {};
  for (const mood of sceneMoods) {
    const category = MOOD_MAP[mood] || 'neutral';
    moodCounts[category] = (moodCounts[category] || 0) + 1;
  }

  // Sort by count descending
  const sorted = Object.entries(moodCounts).sort((a, b) => b[1] - a[1]);
  const dominantMood = sorted[0]?.[0] || 'neutral';

  console.log(`    Music mood analysis: ${JSON.stringify(moodCounts)} → dominant: ${dominantMood}`);

  // Find matching track
  let selected = tracks.find(t => t.mood === dominantMood);

  // Fallback: try secondary mood
  if (!selected && sorted.length > 1) {
    selected = tracks.find(t => t.mood === sorted[1][0]);
  }

  // Fallback: any neutral track
  if (!selected) {
    selected = tracks.find(t => t.mood === 'neutral');
  }

  // Last resort: first available track
  if (!selected) {
    selected = tracks[0];
  }

  if (selected) {
    console.log(`    Selected music: ${selected.filename} (mood: ${selected.mood})`);
  }

  return selected;
}

module.exports = { listTracks, selectForProject, MUSIC_DIR };
