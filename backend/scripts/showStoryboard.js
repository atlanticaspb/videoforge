require('dotenv').config({ path: './config/.env' });
const { getDb } = require('../src/database');

const projectId = process.argv[2] || '2c1e2a4c-e8a1-4ec4-84c9-260ef9934d2e';
const db = getDb();

const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
if (!project) { console.log('Project not found'); process.exit(1); }

const scenes = JSON.parse(project.storyboard || '[]');

console.log(`\n  ${project.name}`);
console.log(`  Style: ${project.style} | Scenes: ${scenes.length} | Status: ${project.status}`);
console.log(`  Audio: ${project.audio_path || 'none'}`);
console.log('');
console.log('─'.repeat(120));
console.log(
  '  #'.padEnd(5) +
  'Timecode'.padEnd(14) +
  'Dur'.padEnd(6) +
  'Narration'.padEnd(45) +
  'Photo'.padEnd(30) +
  'Score  Reasons'
);
console.log('─'.repeat(120));

for (const scene of scenes) {
  const num = String(scene.scene_number || '?').padEnd(3);
  const start = formatTime(scene.start_time);
  const end = formatTime(scene.end_time);
  const timecode = `${start}–${end}`.padEnd(12);
  const dur = `${(scene.end_time - scene.start_time).toFixed(1)}s`.padEnd(4);
  const narration = truncate(scene.narration || '', 43).padEnd(43);

  const photo = scene.selected_photo;
  const photoName = photo ? truncate(cleanFilename(photo.filename), 28).padEnd(28) : '(no photo)'.padEnd(28);
  const score = photo ? String(photo.score || '').padEnd(5) : ''.padEnd(5);
  const reasons = photo?.match_reasons ? photo.match_reasons.slice(0, 3).join(', ') : '';

  console.log(`  ${num}  ${timecode}  ${dur}  ${narration}  ${photoName}  ${score}  ${reasons}`);
}

console.log('─'.repeat(120));
console.log(`\n  Total duration: ${formatTime(scenes[scenes.length - 1]?.end_time || 0)}`);
console.log('');

function formatTime(sec) {
  if (sec == null) return '?:??';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function truncate(str, max) {
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function cleanFilename(name) {
  return name.replace(/^[A-Za-z0-9_-]{20,}_/, '');
}
