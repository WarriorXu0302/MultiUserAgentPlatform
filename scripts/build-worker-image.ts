/**
 * One-shot helper: build a per-agent-group container image based on the
 * group's current container.json packages declaration. Useful after editing
 * packages.apt / packages.pip outside the install_packages MCP flow.
 *
 * Usage:
 *   pnpm exec tsx scripts/build-worker-image.ts <agent_group_id>
 */
import path from 'path';
import { DATA_DIR } from '../src/config.js';
import { initDb, closeDb } from '../src/db/connection.js';
import { buildAgentGroupImage } from '../src/container-runner.js';

async function main(): Promise<void> {
  const agentGroupId = process.argv[2];
  if (!agentGroupId) {
    console.error('usage: pnpm exec tsx scripts/build-worker-image.ts <agent_group_id>');
    process.exit(1);
  }
  initDb(path.join(DATA_DIR, 'v2.db'));
  console.log(`[build] starting buildAgentGroupImage(${agentGroupId})`);
  const t0 = Date.now();
  await buildAgentGroupImage(agentGroupId);
  console.log(`[build] done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  closeDb();
}

main().catch((err) => {
  console.error('[build] failed:', err);
  process.exit(1);
});
