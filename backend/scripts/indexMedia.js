require('dotenv').config({ path: './config/.env' });

const path = require('path');
const { initDatabase } = require('../src/database');
const { indexDirectory } = require('../src/services/mediaIndexer');

const mediaDir = path.resolve(process.argv[2] || process.env.MEDIA_DIR || '../media-library');
const thumbnailDir = path.resolve(process.env.THUMBNAILS_DIR || './thumbnails');

async function main() {
  console.log(`Indexing media from: ${mediaDir}`);
  console.log(`Thumbnails dir: ${thumbnailDir}`);

  initDatabase();

  const results = await indexDirectory(mediaDir, thumbnailDir);

  console.log('\nIndexing complete:');
  console.log(`  Indexed: ${results.indexed}`);
  console.log(`  Skipped: ${results.skipped}`);
  console.log(`  Errors:  ${results.errors}`);
}

main().catch(err => {
  console.error('Indexing failed:', err);
  process.exit(1);
});
