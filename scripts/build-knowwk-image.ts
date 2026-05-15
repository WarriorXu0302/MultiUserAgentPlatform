import path from 'path';
import { DATA_DIR } from '../src/config.js';
import { initDb, closeDb } from '../src/db/connection.js';
import { buildAgentGroupImage } from '../src/container-runner.js';

const AG = 'ag-1778660838-knowwk';

async function main() {
  initDb(path.join(DATA_DIR, 'v2.db'));
  console.log(`[build] starting buildAgentGroupImage(${AG})`);
  const t0 = Date.now();
  await buildAgentGroupImage(AG);
  console.log(`[build] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  closeDb();
}

main().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
