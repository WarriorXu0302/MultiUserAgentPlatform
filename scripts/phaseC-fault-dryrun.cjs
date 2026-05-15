/**
 * Phase C fault dry-run — verify the measurement-semantic fix:
 * inject_to_kill_signal_ms must be ~2000ms (sleep delay), NOT ~12000ms
 * (which would indicate killSignalAt was captured AFTER the blocking
 * docker stop --time 10 call returned).
 *
 * Self-contained: doesn't depend on perf-benchmark.cjs structure.
 * Runs ONE nano SIGTERM iteration, prints timings.
 */
const { execSync } = require('child_process');
const net = require('net');
const path = require('path');

const NANO_ROOT = '/Users/realityloop/nanoclaw_lark/MultiUserAgentPlatform';
const NANO_SOCK = path.join(NANO_ROOT, 'data/cli.sock');

function findNanoContainerNames() {
  try {
    const out = execSync('docker ps --filter "name=frontlane-v2-" --format "{{.Names}}"', { encoding: 'utf8' }).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch { return []; }
}

function nanoSigterm() {
  const names = findNanoContainerNames();
  for (const n of names) {
    try { execSync(`docker stop --time 10 ${n}`, { stdio: 'pipe' }); } catch {}
  }
  return names;
}

function nanoInject(text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(NANO_SOCK);
    s.on('connect', () => {
      s.write(JSON.stringify({
        text,
        to: { channelType: 'feishu', platformId: 'feishu:p2p:ou_a01c96646f754c0da729d6ff3ee5557d', threadId: null },
      }) + '\n');
      setTimeout(() => s.end(), 300);
    });
    s.on('error', reject);
    s.on('close', () => resolve());
  });
}

(async () => {
  console.log('=== fault dry-run: measurement-semantic verification ===\n');

  const beforeContainers = findNanoContainerNames();
  console.log(`pre-existing containers: [${beforeContainers.join(', ')}]`);

  console.log('inject prompt to spin up container...');
  const injectTs = Date.now();
  await nanoInject('请用一句话告诉我现在是哪一年');
  console.log(`inject done at +${Date.now() - injectTs}ms`);

  // R5.5 fix: poll for container alive
  console.log('poll for container alive (timeout 15s)...');
  let containerWaitMs = null;
  let containerNames = [];
  const tWait = Date.now();
  while (Date.now() - tWait < 15000) {
    const names = findNanoContainerNames();
    if (names.length > 0) {
      containerWaitMs = Date.now() - tWait;
      containerNames = names;
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (containerNames.length === 0) {
    console.log('FAIL: no container spawned in 15s');
    process.exit(3);
  }
  console.log(`container alive at +${containerWaitMs}ms (post-inject +${Date.now() - injectTs}ms): [${containerNames.join(',')}]`);

  console.log('wait 2s buffer before firing fault...');
  await new Promise((r) => setTimeout(r, 2000));

  // === MEASUREMENT SEMANTIC: capture ts BEFORE blocking call ===
  const killSignalAt = Date.now();
  console.log(`firing SIGTERM (docker stop --time 10) at +${killSignalAt - injectTs}ms`);
  const killed = nanoSigterm();
  const killReturnedAt = Date.now();
  console.log(`docker stop returned at +${killReturnedAt - injectTs}ms (signal→returned=${killReturnedAt - killSignalAt}ms)`);
  console.log(`killed containers: [${killed.join(', ')}]`);

  const injectToKillMs = killSignalAt - injectTs;
  const kill_signal_to_returned_ms = killReturnedAt - killSignalAt;

  console.log('\n=== verdict ===');
  console.log(`inject_to_kill_signal_ms = ${injectToKillMs}ms`);
  console.log(`  expected: ~2000ms (the 2s sleep)`);
  console.log(`  bad-old-bug: ~12000ms (would mean ts captured AFTER docker stop blocked)`);
  console.log(`  verdict: ${injectToKillMs < 5000 ? 'PASS' : 'FAIL'}`);
  console.log(`kill_signal_to_returned_ms = ${kill_signal_to_returned_ms}ms`);
  console.log(`  this is the docker stop blocking duration (max 10s grace + small overhead)`);
  if (kill_signal_to_returned_ms < 500) {
    console.log(`  ${kill_signal_to_returned_ms}ms < 500ms → container exited gracefully BEFORE grace expired (good)`);
  } else if (kill_signal_to_returned_ms < 11000) {
    console.log(`  ${kill_signal_to_returned_ms}ms < 11000ms → docker stop blocked within grace window`);
  } else {
    console.log(`  ${kill_signal_to_returned_ms}ms unexpected — check docker daemon health`);
  }

  process.exit(injectToKillMs < 5000 ? 0 : 1);
})().catch((e) => { console.error('FAIL:', e); process.exit(2); });
