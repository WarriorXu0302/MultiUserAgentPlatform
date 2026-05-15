/**
 * Phase C cleanup — remove all messaging_groups + dependents created by
 * phaseC-precreate-bench-mgs.ts (or by any bench injection that matched
 * the bench prefix).
 *
 * Usage (from MultiUserAgentPlatform/ dir):
 *   pnpm exec tsx scripts/phaseC-cleanup-bench-mgs.ts
 *   BENCH_PREFIX_LIKE="feishu:p2p:nanoclaw-bench-%" pnpm exec tsx scripts/phaseC-cleanup-bench-mgs.ts
 *
 * Cleanup order respects FK constraints:
 *   1. messaging_group_agents (wirings)
 *   2. sessions (any runtime spawned during testing)
 *   3. messaging_groups
 * Plus filesystem removal of data/v2-sessions/<agent_group_id>/<session_id>/
 *
 * NOT cleaned: enterprise_audit rows. Audit is append-only by design; rows
 * referring to bench mgs become orphan FKs but stay as historical record.
 *
 * Idempotent: re-running after empty set is a no-op.
 */
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { initDb, getDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';

const PREFIX_LIKE = process.env.BENCH_PREFIX_LIKE || 'feishu:p2p:nanoclaw-bench-%';
const DB_PATH = process.env.NANOCLAW_DB || 'data/v2.db';
const SESSIONS_DIR = path.resolve(process.cwd(), 'data', 'v2-sessions');
const GRACE_SECONDS = parseInt(process.env.CLEANUP_SIGTERM_GRACE || '10', 10);

/**
 * Find docker containers whose /workspace mount source path references any
 * of the snapshotted session_ids. Returns [{ name, session_id }].
 * Anchor: container name format is `frontlane-v2-<folder>-<ts>` (src/
 * container-runner.ts:178), session_id is NOT in the name but IS in the
 * /workspace mount hostPath (src/container-runner.ts:312-316).
 */
function findContainersForSessions(sessionIds: string[]): { name: string; session_id: string }[] {
  if (sessionIds.length === 0) return [];
  const hits: { name: string; session_id: string }[] = [];
  let names: string[] = [];
  try {
    const out = execSync('docker ps --filter "name=frontlane-v2-" --format "{{.Names}}"', { encoding: 'utf8' }).trim();
    names = out ? out.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
  for (const n of names) {
    try {
      const inspect = execSync(`docker inspect "${n}"`, { encoding: 'utf8' });
      for (const sid of sessionIds) {
        if (inspect.includes(sid)) {
          hits.push({ name: n, session_id: sid });
          break;
        }
      }
    } catch {
      // container may have exited between ps and inspect — skip
    }
  }
  return hits;
}

// NOTE: cleanup originally did NOT include docker stop. Prior assumption
// was "cleanup should not touch container lifecycle". That was overturned
// by phaseC dry-run revealing EBUSY on rmSync when container is still
// running (fs.rmSync threw on macOS when docker mount source dir was
// held by a live container, causing cleanup script exit 1 and half-cleaned
// session state). docker stop (SIGTERM, 10s grace) is now required for
// cleanup correctness. Do not remove without re-validating with a
// live-container scenario.
/**
 * SIGTERM with grace, then SIGKILL fallback. Returns timeline per container.
 * - docker stop --time <GRACE_SECONDS>: sends SIGTERM, waits up to N seconds
 *   for graceful exit; if still alive, SIGKILL.
 * - Always SIGTERM-first preserves Phase C semantics: cleanup-related kills
 *   take the graceful path; only C.4b's fault test uses raw SIGKILL.
 */
function stopContainersGracefully(containers: { name: string; session_id: string }[]): unknown[] {
  return containers.map((c) => {
    const t0 = Date.now();
    let outcome = 'unknown';
    let error: string | undefined;
    try {
      execSync(`docker stop --time ${GRACE_SECONDS} "${c.name}"`, { encoding: 'utf8' });
      outcome = 'stopped_within_grace';
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      error = msg;
      // docker stop returns non-zero when container is already gone, treat as ok
      if (/No such container|is not running/i.test(msg)) {
        outcome = 'already_gone';
      } else {
        outcome = 'stop_failed';
      }
    }
    // Sanity: verify container is no longer running
    let stillUp = false;
    try {
      const live = execSync(`docker ps --filter "name=${c.name}" --format "{{.Names}}"`, { encoding: 'utf8' }).trim();
      stillUp = live.length > 0;
    } catch {
      // ignore
    }
    // SIGKILL fallback if --time didn't suffice
    if (stillUp) {
      try {
        execSync(`docker kill "${c.name}"`, { encoding: 'utf8' });
        outcome = 'killed_after_grace_expired';
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        error = `kill fallback also failed: ${msg}`;
        outcome = 'kill_fallback_failed';
      }
    }
    return {
      container: c.name,
      session_id: c.session_id,
      outcome,
      elapsed_ms: Date.now() - t0,
      error,
    };
  });
}

function main(): void {
  const db = initDb(DB_PATH);
  runMigrations(db);

  const dbConn = getDb();

  // 1. Collect impacted mgs
  const mgs = dbConn
    .prepare(`SELECT id FROM messaging_groups WHERE channel_type = 'feishu' AND platform_id LIKE ?`)
    .all(PREFIX_LIKE) as { id: string }[];

  if (mgs.length === 0) {
    console.log('no bench messaging_groups found; nothing to clean.');
    return;
  }
  const mgIds = mgs.map((m) => m.id);
  console.log(`found ${mgIds.length} bench mgs:`, mgIds);

  // 2. Collect associated sessions (need agent_group_id for fs cleanup)
  const placeholders = mgIds.map(() => '?').join(',');
  const sessions = dbConn
    .prepare(`SELECT id, agent_group_id FROM sessions WHERE messaging_group_id IN (${placeholders})`)
    .all(...mgIds) as { id: string; agent_group_id: string }[];
  console.log(`found ${sessions.length} associated sessions`);

  // 3. PRE-DELETE: stop any docker containers whose mount paths reference
  //    this group's session_ids. We do this BEFORE deleting db rows + rm-ing
  //    dirs to avoid EBUSY from a still-running container holding mount
  //    handles. SIGTERM + grace (default 10s), SIGKILL fallback if it
  //    doesn't exit. Without this, the previous round saw partial fs.rmSync
  //    + exit 1 in cleanup, leaving phantom container state and half-cleaned
  //    session dirs.
  const sessionIds = sessions.map((s) => s.id);
  const containerHits = findContainersForSessions(sessionIds);
  console.log(`containers referencing these sessions: ${containerHits.length}`);
  let containerStopResults: unknown[] = [];
  if (containerHits.length > 0) {
    containerStopResults = stopContainersGracefully(containerHits);
    console.log(`container stop results: ${JSON.stringify(containerStopResults)}`);
  }

  // 4. Transactional delete in FK order
  const tx = dbConn.transaction(() => {
    const deletedMga = dbConn
      .prepare(`DELETE FROM messaging_group_agents WHERE messaging_group_id IN (${placeholders})`)
      .run(...mgIds).changes;
    const deletedSessions = dbConn
      .prepare(`DELETE FROM sessions WHERE messaging_group_id IN (${placeholders})`)
      .run(...mgIds).changes;
    const deletedMgs = dbConn
      .prepare(`DELETE FROM messaging_groups WHERE id IN (${placeholders})`)
      .run(...mgIds).changes;
    console.log(`db rows deleted: mga=${deletedMga} sessions=${deletedSessions} mgs=${deletedMgs}`);
  });
  tx();

  // 5. Filesystem cleanup (containers are stopped → no EBUSY)
  //    Each rm wrapped to log error + continue if some artifact persists
  //    (rare on macOS; container exit may leave whisker file handles briefly).
  let dirsRemoved = 0;
  let dirsAbsent = 0;
  let dirsFailed: { dir: string; error: string }[] = [];
  for (const s of sessions) {
    const dir = path.join(SESSIONS_DIR, s.agent_group_id, s.id);
    if (fs.existsSync(dir)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        dirsRemoved++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        dirsFailed.push({ dir, error: msg });
        console.error(`rmSync failed for ${dir}: ${msg}`);
      }
    } else {
      dirsAbsent++;
    }
  }
  console.log(`session dirs removed=${dirsRemoved} absent=${dirsAbsent} failed=${dirsFailed.length}`);
  if (dirsFailed.length > 0) {
    console.error(`failed dir removals: ${JSON.stringify(dirsFailed)}`);
  }
  console.log('cleanup complete. enterprise_audit rows preserved (append-only).');
}

main();
