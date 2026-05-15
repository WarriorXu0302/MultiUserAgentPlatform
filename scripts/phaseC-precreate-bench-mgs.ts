/**
 * Phase C precreate — populate N feishu:p2p messaging_groups + autowire to
 * frontdesk so C.2b multi-session injections bypass router.ts:206 silent-drop.
 *
 * Mirrors the auto-create + autowire path that real Feishu p2p inbound goes
 * through (router.ts:218 createMessagingGroup → :224 maybeAutowireEnterpriseFrontdesk).
 * Done ahead of time so the 5 concurrent injections in C.2b don't serialize
 * on auto-create + audit writes.
 *
 * Usage (from MultiUserAgentPlatform/ dir):
 *   pnpm exec tsx scripts/phaseC-precreate-bench-mgs.ts
 *   # or with overrides:
 *   BENCH_COUNT=5 BENCH_PREFIX="feishu:p2p:nanoclaw-bench-" pnpm exec tsx scripts/phaseC-precreate-bench-mgs.ts
 *
 * Idempotent: skips platformIds whose mg already exists. Aborts on first
 * unrecoverable error (does not auto-rollback partials — call the cleanup
 * script if needed).
 */
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getDb } from '../src/db/connection.js';
import { createMessagingGroup, getMessagingGroupByPlatform } from '../src/db/messaging-groups.js';
import { maybeAutowireEnterpriseFrontdesk } from '../src/enterprise-autowire.js';
import type { MessagingGroup } from '../src/types.js';
import type { InboundEvent } from '../src/channels/adapter.js';

const COUNT = parseInt(process.env.BENCH_COUNT || '5', 10);
const PREFIX = process.env.BENCH_PREFIX || 'feishu:p2p:nanoclaw-bench-';
const DB_PATH = process.env.NANOCLAW_DB || 'data/v2.db';

function pad(n: number): string {
  return String(n).padStart(3, '0');
}

function main(): void {
  const db = initDb(DB_PATH);
  runMigrations(db);

  const created: string[] = [];
  const skipped: string[] = [];
  const failed: { platformId: string; error: string }[] = [];

  for (let i = 1; i <= COUNT; i++) {
    const platformId = `${PREFIX}${pad(i)}`;
    if (getMessagingGroupByPlatform('feishu', platformId)) {
      skipped.push(platformId);
      console.log(`skip ${platformId} (already exists)`);
      continue;
    }
    try {
      const mgId = `mg-bench-${Date.now()}-${pad(i)}`;
      const mg: MessagingGroup = {
        id: mgId,
        channel_type: 'feishu',
        platform_id: platformId,
        name: null,
        is_group: 0,
        unknown_sender_policy: 'public', // skips downgrade audit (enterprise-autowire.ts:147)
        denied_at: null,
        created_at: new Date().toISOString(),
      };
      createMessagingGroup(mg);

      // Mimic a Feishu p2p inbound event for the autowire check.
      // feishu.ts:392-394 shows p2p forces isMention=true; we replicate.
      const event: InboundEvent = {
        channelType: 'feishu',
        platformId,
        threadId: null,
        message: {
          id: `bench-init-${pad(i)}`,
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({
            text: 'bench init',
            sender: 'bench',
            senderId: `bench:${pad(i)}`,
          }),
          isMention: true,
          isGroup: false,
        },
      };
      const wired = maybeAutowireEnterpriseFrontdesk(mg, event);
      if (!wired) {
        failed.push({
          platformId,
          error:
            'autowire returned false (frontdesk missing? autowire disabled? denied? — check enterprise-autowire.ts:120-140)',
        });
        continue;
      }
      created.push(platformId);
      console.log(`ok   ${platformId}  mgId=${mgId}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failed.push({ platformId, error: msg });
      console.error(`FAIL ${platformId}: ${msg}`);
    }
  }

  console.log('\n--- summary ---');
  console.log(`created: ${created.length}`);
  console.log(`skipped: ${skipped.length}`);
  console.log(`failed:  ${failed.length}`);
  if (failed.length > 0) {
    console.error('\nfailed entries:');
    console.error(JSON.stringify(failed, null, 2));
    process.exit(2);
  }
}

main();
