/**
 * Temporary helper: wire the CLI channel (cli/local) to the existing FrontLane
 * Desk (frontdesk) agent group so `pnpm run chat` drives the real lab dispatch
 * chain instead of a scratch agent. Removable via:
 *   DELETE FROM messaging_group_agents WHERE messaging_group_id=<id>;
 *
 * Usage:
 *   pnpm exec tsx scripts/wire-cli-to-frontdesk.ts
 */
import path from 'path';
import { DATA_DIR } from '../src/config.js';
import { initDb, closeDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { upsertUser } from '../src/modules/permissions/db/users.js';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';
const CLI_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;
const FRONTDESK_AG = 'ag-1778488029905-vpov75';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function main(): void {
  initDb(path.join(DATA_DIR, 'v2.db'));
  const now = new Date().toISOString();

  // Ensure synthetic user exists (so sender resolution doesn't drop messages).
  upsertUser({ id: CLI_USER_ID, kind: CLI_CHANNEL, display_name: 'cli-local', created_at: now });
  console.log(`upserted user: ${CLI_USER_ID}`);

  let mg = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!mg) {
    mg = {
      id: genId('mg'),
      channel_type: CLI_CHANNEL,
      platform_id: CLI_PLATFORM_ID,
      name: 'CLI Local',
      is_group: 0,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: now,
    };
    createMessagingGroup(mg);
    console.log(`created messaging_group: ${mg.id}`);
  } else {
    console.log(`reused messaging_group: ${mg.id}`);
  }

  const existing = getMessagingGroupAgentByPair(mg.id, FRONTDESK_AG);
  if (existing) {
    console.log(`wiring already exists: ${existing.id}`);
  } else {
    createMessagingGroupAgent({
      id: genId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: FRONTDESK_AG,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`wired cli/local → frontdesk (${FRONTDESK_AG})`);
  }
  closeDb();
}

main();
