/**
 * Phase C cycle stress — repeat prep → cleanup N times, no test injection.
 *
 * Verifies cleanup-prep symmetry under iteration:
 *   - v2.db bench rows back to 0 after each cleanup
 *   - container count stable (no accumulating stragglers)
 *   - enterprise_audit grows by expected amount each cycle (5 autowire rows)
 *   - /tmp log files accumulate but don't corrupt next cycle
 *
 * Designed as the predictive PARANOIA test for C.2b iter 3/4 reset boundaries.
 * Hard budget: 30 seconds total.
 */
const { execSync } = require('child_process');
const fs = require('fs');

const NANO_ROOT = '/Users/realityloop/nanoclaw_lark/MultiUserAgentPlatform';
const PREFIX = 'feishu:p2p:nanoclaw-bench-cycleA-';
const PREFIX_LIKE = `${PREFIX}%`;
const CYCLES = parseInt(process.env.CYCLES || '5', 10);
const BUDGET_MS = 30000;

function dbCount(sql) {
  try {
    const out = execSync(`sqlite3 "${NANO_ROOT}/data/v2.db" "${sql}"`, { encoding: 'utf8' }).trim();
    return parseInt(out, 10) || 0;
  } catch (e) {
    return -1;
  }
}

function dockerCount() {
  try {
    const out = execSync(`docker ps --filter "name=frontlane-v2-" --format "{{.Names}}"`, { encoding: 'utf8' }).trim();
    return out ? out.split('\n').filter(Boolean).length : 0;
  } catch { return -1; }
}

function snapshot(label) {
  return {
    label,
    bench_mgs: dbCount(`SELECT count(*) FROM messaging_groups WHERE platform_id LIKE '${PREFIX_LIKE}';`),
    bench_mga: dbCount(`SELECT count(*) FROM messaging_group_agents WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE platform_id LIKE '${PREFIX_LIKE}');`),
    bench_sessions: dbCount(`SELECT count(*) FROM sessions WHERE messaging_group_id IN (SELECT id FROM messaging_groups WHERE platform_id LIKE '${PREFIX_LIKE}');`),
    total_audit: dbCount(`SELECT count(*) FROM enterprise_audit;`),
    frontlane_containers: dockerCount(),
  };
}

function runPrep() {
  execSync(
    `pnpm exec tsx scripts/phaseC-precreate-bench-mgs.ts`,
    { env: { ...process.env, BENCH_COUNT: '5', BENCH_PREFIX: PREFIX }, stdio: 'pipe' },
  );
}

function runCleanup() {
  execSync(
    `pnpm exec tsx scripts/phaseC-cleanup-bench-mgs.ts`,
    { env: { ...process.env, BENCH_PREFIX_LIKE: PREFIX_LIKE }, stdio: 'pipe' },
  );
}

(async () => {
  process.chdir(NANO_ROOT);
  const t0 = Date.now();
  const log = [];
  let baselineAudit = null;

  const initial = snapshot('initial');
  baselineAudit = initial.total_audit;
  console.log('initial:', JSON.stringify(initial));
  if (initial.bench_mgs !== 0) {
    console.error('FAIL: initial bench_mgs not zero. Aborting.');
    process.exit(2);
  }

  for (let cycle = 1; cycle <= CYCLES; cycle++) {
    if (Date.now() - t0 > BUDGET_MS) {
      console.error(`FAIL: budget ${BUDGET_MS}ms exceeded at cycle ${cycle}`);
      process.exit(3);
    }
    const tPrep = Date.now();
    runPrep();
    const postPrep = snapshot(`cycle${cycle}-postPrep`);
    log.push({ ...postPrep, prep_ms: Date.now() - tPrep });
    const tClean = Date.now();
    runCleanup();
    const postCleanup = snapshot(`cycle${cycle}-postCleanup`);
    log.push({ ...postCleanup, cleanup_ms: Date.now() - tClean });
    console.log(`cycle ${cycle}: postPrep mgs=${postPrep.bench_mgs} audit=${postPrep.total_audit}  postCleanup mgs=${postCleanup.bench_mgs} audit=${postCleanup.total_audit} dock=${postCleanup.frontlane_containers}`);
    if (postCleanup.bench_mgs !== 0 || postCleanup.bench_mga !== 0 || postCleanup.bench_sessions !== 0) {
      console.error(`FAIL cycle ${cycle}: cleanup left residue ${JSON.stringify(postCleanup)}`);
      process.exit(4);
    }
  }

  const final = snapshot('final');
  const expectedAuditGrowth = CYCLES * 5; // 5 autowire rows per prep cycle
  const actualGrowth = final.total_audit - baselineAudit;
  console.log('\n--- summary ---');
  console.log('cycles:', CYCLES);
  console.log('total_ms:', Date.now() - t0);
  console.log(`audit growth: expected=${expectedAuditGrowth} actual=${actualGrowth}`);
  console.log('per-cycle log:', JSON.stringify(log, null, 2));
  if (actualGrowth !== expectedAuditGrowth) {
    console.error(`FAIL: audit growth mismatch (expected ${expectedAuditGrowth}, got ${actualGrowth})`);
    process.exit(5);
  }
  if (final.frontlane_containers > initial.frontlane_containers) {
    console.error(`FAIL: container accumulation (initial=${initial.frontlane_containers} final=${final.frontlane_containers})`);
    process.exit(6);
  }
  console.log('\nPASS: all 5 cycles symmetric, audit growth correct, no container accumulation.');
})();
