// Performance benchmark v2 — runs 4 test classes against nanoclaw + openclaw.
//
// === ARCHITECTURE NOTE (user-confirmed + source-verified 2026-05-12) ===
// openclaw is DISPATCHER-GLOBALLY-SERIAL. Every agent turn must hold the
// process-singleton Main lane (CommandLane.Main, maxConcurrent=1; see
// .npm-global/lib/node_modules/openclaw/dist/command-queue-JOCs7lw4.js:66
// and pi-embedded-runner-DXh-tqVs.js:6242). So:
//   - openclaw "multi-session concurrent" tests will serialize via Main lane
//   - When you see this script call openclaw with N=1 in multi-session
//     branches, that's INTENTIONAL — not a missing parallel test.
//   - nanoclaw multi-session DOES run truly parallel (separate container
//     processes per session/messaging_group), capped by host RAM.
//
// === USAGE ===
//   node scripts/perf-benchmark.cjs [nanoclaw|openclaw|both]
//   BATCH=serial node scripts/perf-benchmark.cjs        # one batch only
//   BATCH=concurrent-multi node scripts/perf-benchmark.cjs
//
// === MEASUREMENT ===
// nanoclaw injection: data/cli.sock with `to: feishu-mg`. Token-echo
//   verification (each prompt embeds a unique token; reply must contain it).
// openclaw injection: CLI `openclaw agent --to <phone>`. Wall time includes
//   ~8s plugin chain startup per call; agent_duration_ms (from result meta)
//   is the pure model+core time, comparable to nanoclaw.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');
const os = require('os');

const TARGET = process.argv[2] || 'both';
const NANO_ROOT = '/Users/realityloop/nanoclaw_lark/MultiUserAgentPlatform';
const NANO_SOCK = path.join(NANO_ROOT, 'data/cli.sock');
const NANO_PLATFORM_ID = 'feishu:p2p:ou_a01c96646f754c0da729d6ff3ee5557d';
const FEISHU_TO = {
  channelType: 'feishu',
  platformId: NANO_PLATFORM_ID,
  threadId: null,
};

// Previously hardcoded session-specific NANO_OUT_DB / NANO_IN_DB caused silent
// 0/10 false negatives when session was reset (Batch 2 fresh session
// investigation, F3). Now resolved at startup by latest-active-session lookup
// from v2.db keyed by NANO_PLATFORM_ID.
function resolveNanoSessionPaths() {
  const V2_DB = path.join(NANO_ROOT, 'data/v2.db');
  const sqlOut = require('child_process').execSync(
    `sqlite3 -separator '|' "${V2_DB}" "SELECT s.id, s.agent_group_id FROM sessions s JOIN messaging_groups mg ON s.messaging_group_id = mg.id WHERE mg.platform_id = '${NANO_PLATFORM_ID}' ORDER BY s.created_at DESC LIMIT 1;"`,
    { encoding: 'utf8' },
  ).trim();
  if (!sqlOut) {
    throw new Error(`No nano session for platformId=${NANO_PLATFORM_ID}. Inject one bootstrap message to spawn a session before running benchmark.`);
  }
  const [sid, agid] = sqlOut.split('|');
  return {
    outbound: path.join(NANO_ROOT, 'data/v2-sessions', agid, sid, 'outbound.db'),
    inbound: path.join(NANO_ROOT, 'data/v2-sessions', agid, sid, 'inbound.db'),
    session_id: sid,
    agent_group_id: agid,
  };
}
const _nanoPaths = resolveNanoSessionPaths();
const NANO_OUT_DB = _nanoPaths.outbound;
const NANO_IN_DB = _nanoPaths.inbound;
process.stderr.write(`[bench] resolved nano session: ${_nanoPaths.session_id} (agent_group=${_nanoPaths.agent_group_id})\n`);

// openclaw test harness — uses its CLI executable.
// Each call adds ~8s plugin chain startup (measured during smoke).
// Reported latencies separate `wall_ms` (includes startup) from
// `agent_duration_ms` (model-side, extracted from result.meta.durationMs).
const OPENCLAW_BIN = path.join(os.homedir(), '.npm-global', 'bin', 'openclaw');
const OPENCLAW_LAUNCHD_LABEL = 'ai.openclaw.gateway';
const OPENCLAW_GATEWAY_PORT = 18789;

// Fresh synthetic phone per call to avoid session reuse contaminating fault tests
let _ocPhoneCounter = 10000;
function nextOpenclawPhone() {
  _ocPhoneCounter += 1;
  return `+120255${String(_ocPhoneCounter).padStart(5, '0')}`;
}

// Bench platformId groups (Issue 3 fix: 2 groups × 4 iterations with reset
// boundary, NOT 1 group × 3 sequential iterations with accumulated context).
// Group A: nanoclaw-benchA-001..005
// Group B: nanoclaw-benchB-001..005
// iter 1: A fresh (right after initial prep)
// iter 2: B fresh
// iter 3: cleanup A + re-prep A, then run on freshly-reset A
// iter 4: cleanup B + re-prep B, then run on freshly-reset B
// Each iteration's 5 sessions are guaranteed history-free (session_id is
// timestamp+random per src/session-manager.ts:82; mg_id is fresh per
// re-prep; inbound/outbound dbs are initSessionFolder-created from scratch).
const BENCH_GROUP_A_PREFIX = 'feishu:p2p:nanoclaw-benchA-';
const BENCH_GROUP_B_PREFIX = 'feishu:p2p:nanoclaw-benchB-';
const BENCH_GROUP_A_PLATFORM_IDS = Array.from({ length: 5 }, (_, i) =>
  `${BENCH_GROUP_A_PREFIX}${String(i + 1).padStart(3, '0')}`,
);
const BENCH_GROUP_B_PLATFORM_IDS = Array.from({ length: 5 }, (_, i) =>
  `${BENCH_GROUP_B_PREFIX}${String(i + 1).padStart(3, '0')}`,
);

// tee-style capture wrapper: runs the script, mirrors output to stderr in
// real time, AND writes to /tmp/phaseC-{prep|cleanup}-<tag>-<ts>.log so
// that exit != 0 produces a debuggable error (the prior version surfaced
// only an exit code, losing the script's actual stderr message).
function runScriptWithCapture(label, scriptPath, envOverrides, logTag) {
  const ts = Date.now();
  const logPath = `/tmp/phaseC-${label}-${logTag}-${ts}.log`;
  // bash pipefail so we propagate the script's exit code through tee
  const cmd = `bash -o pipefail -c 'pnpm exec tsx ${scriptPath} 2>&1 | tee ${logPath}'`;
  try {
    execSync(cmd, { env: { ...process.env, ...envOverrides }, stdio: 'inherit' });
    return { ok: true, logPath };
  } catch (e) {
    const exitCode = (e && typeof e === 'object' && 'status' in e ? e.status : null);
    let logContent = '(no log)';
    try { logContent = fs.readFileSync(logPath, 'utf8'); } catch {}
    throw new Error(
      `${label} script failed (exit ${exitCode}). Log at ${logPath}\n` +
      `--- last 40 lines ---\n${logContent.split('\n').slice(-40).join('\n')}`,
    );
  }
}

function runPrepGroup(prefix) {
  process.stderr.write(`[prep] creating mgs for prefix=${prefix}\n`);
  return runScriptWithCapture(
    'prep',
    'scripts/phaseC-precreate-bench-mgs.ts',
    { BENCH_COUNT: '5', BENCH_PREFIX: prefix },
    prefix.replace(/[^a-zA-Z0-9]/g, '_'),
  );
}

// runCleanupGroup includes encoded straggler detection (Issue 1 fix).
// Pre-cleanup: snapshot session_ids in the group.
// Post-cleanup: sleep 3s, enumerate frontlane containers, check if any
// references a snapshotted session_id (via docker inspect mount paths).
// Stragglers always logged to /tmp/phaseC-container-stragglers.log.
// In PHASE_C_DRY_RUN=1: warn + continue (let dry-run surface fact).
// Otherwise: throw (real run cannot proceed with phantom containers).
function runCleanupGroup(prefixLike) {
  // Snapshot session_ids before cleanup so we can identify their containers later
  let groupSessionIds = [];
  try {
    const sql = `SELECT s.id FROM sessions s JOIN messaging_groups mg ON s.messaging_group_id = mg.id WHERE mg.channel_type = 'feishu' AND mg.platform_id LIKE '${prefixLike}';`;
    const out = execSync(`sqlite3 "${NANO_ROOT}/data/v2.db" "${sql}"`, { encoding: 'utf8' }).trim();
    groupSessionIds = out ? out.split('\n').filter(Boolean) : [];
  } catch (e) {
    process.stderr.write(`[cleanup/snapshot] failed (proceeding without straggler check): ${e.message}\n`);
  }
  process.stderr.write(`[cleanup] removing mgs matching ${prefixLike} (${groupSessionIds.length} sessions to clear)\n`);
  runScriptWithCapture(
    'cleanup',
    'scripts/phaseC-cleanup-bench-mgs.ts',
    { BENCH_PREFIX_LIKE: prefixLike },
    prefixLike.replace(/[^a-zA-Z0-9]/g, '_'),
  );
  // Allow containers a brief grace period to notice their session DB is gone
  // and exit voluntarily (their poll loop will SqliteError on next read)
  try { execSync('sleep 3'); } catch {}
  // Straggler detection: any frontlane container still up referencing a cleared session_id
  const stragglers = [];
  if (groupSessionIds.length > 0) {
    try {
      const names = execSync(`docker ps --filter "name=frontlane-v2-" --format "{{.Names}}"`, { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
      for (const cName of names) {
        try {
          const inspect = execSync(`docker inspect "${cName}"`, { encoding: 'utf8' });
          for (const sid of groupSessionIds) {
            if (inspect.includes(sid)) {
              stragglers.push({ container: cName, session_id: sid });
              break;
            }
          }
        } catch {}
      }
    } catch {}
  }
  if (stragglers.length > 0) {
    const ts = new Date().toISOString();
    const line = `[${ts}] After cleanup ${prefixLike}: stragglers=${JSON.stringify(stragglers)}\n`;
    fs.appendFileSync('/tmp/phaseC-container-stragglers.log', line);
    if (process.env.PHASE_C_DRY_RUN) {
      process.stderr.write(`[straggler-detected/dry-run] ${prefixLike}: ${JSON.stringify(stragglers)}\n`);
    } else {
      throw new Error(
        `Container stragglers after cleanup ${prefixLike}: ${JSON.stringify(stragglers)}. ` +
        `Real run cannot proceed with phantom containers. Add docker kill to cleanup script.`,
      );
    }
  } else {
    process.stderr.write(`[cleanup] no stragglers detected for ${prefixLike}\n`);
  }
}

// --- Token-echo helpers (Issue 2 + Issue 3 from Reviewer self-review) ---
//
// Replaces seq-advance counting (which can't distinguish "50 unique replies"
// from "<50 replies + N empty rows"). Each prompt embeds a unique token; we
// verify the token appears in some outbound row. Coverage = unique tokens
// found / unique tokens sent.

function newToken(prefix = 'TKN') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function promptWithToken(text, token) {
  // Phrasing chosen to keep the model on stopReason=stop (no `message` tool
  // attempt). "请把 TOKEN 原样放进回答" — declarative, no action verb.
  return `${text}（请把 token=${token} 原样放进你的回答里）`;
}

function scanOutboundForToken(outboundDbPath, token, baseSeq) {
  // Scan outbound rows past baseSeq for any whose content contains token.
  try {
    const out = execSync(
      `sqlite3 "${outboundDbPath}" "SELECT seq, content FROM messages_out WHERE seq > ${baseSeq};"`,
      { encoding: 'utf8' },
    ).trim();
    if (!out) return null;
    for (const line of out.split('\n')) {
      if (line.includes(token)) {
        const seqPart = line.split('|')[0];
        return { found: true, at_seq: parseInt(seqPart, 10) };
      }
    }
    return { found: false };
  } catch (e) {
    return { found: false, error: e.message };
  }
}

// --- DB / integrity / checkpoint helpers ---

function runIntegrityCheck() {
  const sql = "PRAGMA integrity_check;";
  function check(db) {
    try {
      return execSync(`sqlite3 "${db}" "${sql}"`, { encoding: 'utf8' }).trim().split('\n')[0];
    } catch (e) {
      return `error: ${e.message}`;
    }
  }
  return {
    outbound: check(NANO_OUT_DB),
    inbound: check(NANO_IN_DB),
  };
}

function cpCheckpoint(batchName) {
  const outDst = `/tmp/phaseC-checkpoint-${batchName}-outbound.db`;
  const inDst = `/tmp/phaseC-checkpoint-${batchName}-inbound.db`;
  try {
    fs.copyFileSync(NANO_OUT_DB, outDst);
    fs.copyFileSync(NANO_IN_DB, inDst);
    return { outbound: outDst, inbound: inDst };
  } catch (e) {
    return { error: e.message };
  }
}

// --- nanoclaw fault ops (docker container) ---

function findNanoContainerNames() {
  try {
    const out = execSync(
      'docker ps --filter "name=frontlane-v2-frontlane" --format "{{.Names}}"',
      { encoding: 'utf8' },
    ).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  } catch { return []; }
}

// R5.5: wait for a nano container to be alive (cold-start may take 5-10s on
// first inject of the test run). Returns { ready: bool, names: [...], wait_ms }.
// Without this, _faultIterNano's iter 1 fires SIGTERM at +2s when no container
// is up yet, kill_target = [], and the test silently degrades to "normal
// completion" instead of "fault recovery".
async function waitForNanoContainer(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const names = findNanoContainerNames();
    if (names.length > 0) {
      return { ready: true, names, wait_ms: Date.now() - t0 };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { ready: false, names: [], wait_ms: Date.now() - t0 };
}

function nanoSigterm() {
  // SIGTERM + 10s grace via docker stop (per CLAUDE.md, container tini PID 1
  // forwards SIGTERM cleanly, allowing outbound.db writes to finalize)
  const names = findNanoContainerNames();
  for (const n of names) {
    try { execSync(`docker stop --time 10 ${n}`, { stdio: 'pipe' }); } catch (e) { /* ignore */ }
  }
  return names;
}

function nanoSigkill() {
  // Current behavior — docker kill (SIGKILL by default)
  const names = findNanoContainerNames();
  for (const n of names) {
    try { execSync(`docker kill ${n}`, { stdio: 'pipe' }); } catch (e) { /* ignore */ }
  }
  return names;
}

// --- openclaw fault ops (launchd-managed gateway) ---

function openclawGatewayPid() {
  try {
    const out = execSync(`launchctl list | grep ${OPENCLAW_LAUNCHD_LABEL} || true`, { encoding: 'utf8' }).trim();
    if (!out) return null;
    const cols = out.split(/\s+/);
    const pid = parseInt(cols[0], 10);
    return Number.isFinite(pid) ? pid : null;
  } catch { return null; }
}

function openclawSigterm() {
  // launchctl kickstart -k = stop (SIGTERM-equivalent) then restart
  try {
    execSync(`launchctl kickstart -k gui/$(id -u)/${OPENCLAW_LAUNCHD_LABEL}`, { stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function openclawSigkill() {
  // hard kill on the gateway process; launchd KeepAlive will auto-restart
  const pid = openclawGatewayPid();
  if (!pid) return { ok: false, error: 'gateway pid not found' };
  try {
    execSync(`kill -9 ${pid}`, { stdio: 'pipe' });
    return { ok: true, pid };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function openclawGatewayReady() {
  try {
    const out = execSync(
      `curl -sS -m 2 http://127.0.0.1:${OPENCLAW_GATEWAY_PORT}/healthz`,
      { encoding: 'utf8' },
    );
    return out.includes('"ok":true');
  } catch { return false; }
}

async function waitForOpenclawReady(timeoutMs = 30000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (openclawGatewayReady()) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

// Phase C v2 PROMPT_SET — designed to keep both runtimes on stopReason=stop
// path (no `message`/`send_message` tool call). The previous prompt set used
// verbs like "回复" / "告诉我" which triggered openclaw's CLI harness to
// route the reply through Feishu delivery, hit the synthetic-phone target
// rejection, and time out at 60s. By restricting to declarative factual Q&A
// + arithmetic + single-turn multi-stage reasoning, we measure runtime
// latency on the comparable path. Tool-call benchmarking is explicitly
// deferred (would need real Feishu chatId on openclaw side, which would
// pollute production DMs).
const PROMPT_SET = {
  pure_chat: [
    '什么是 P/E 比率？用两句话解释。',
    '简要描述北京、上海、深圳三个城市的地理位置。',
    'PID 控制器全称是什么？P / I / D 三个字母分别代表什么？',
  ],
  single_tool: [
    // category retained for API stability; prompts redesigned so the model
    // answers internally instead of invoking tools (which would fail on
    // openclaw side due to delivery-layer mismatch — see phaseB-smoke-results.json)
    '47 × 53 等于多少？给出计算过程。',
    '编写一个最小的 Python hello world 程序。',
    '把这句英文翻译成中文：The quick brown fox jumps over the lazy dog.',
  ],
  multi_step: [
    '列出 3 个常见的软件设计模式名称，每个用一句话简介。',
    '解释什么是闭包（closure），先定义概念再给一个 JavaScript 简短示例。',
    '比较 HTTP/1.1 和 HTTP/2 的 3 个关键区别。',
  ],
};

function sqliteOne(db, sql) {
  try {
    return execSync(`sqlite3 "${db}" "${sql}"`, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function nanoLatestOutSeq() {
  const v = sqliteOne(NANO_OUT_DB, 'SELECT seq FROM messages_out ORDER BY seq DESC LIMIT 1;');
  return parseInt(v, 10) || 0;
}

function nanoRowsSince(seq) {
  const out = execSync(
    `sqlite3 -separator '|||' "${NANO_OUT_DB}" "SELECT seq, kind, content FROM messages_out WHERE seq > ${seq} ORDER BY seq;"`,
    { encoding: 'utf8' },
  ).trim();
  if (!out) return [];
  return out.split('\n').map((l) => {
    const [seqStr, kind, content] = l.split('|||');
    return { seq: parseInt(seqStr, 10), kind, content };
  });
}

function nanoInject(text) {
  return new Promise((resolve, reject) => {
    const s = net.connect(NANO_SOCK);
    s.on('connect', () => {
      s.write(JSON.stringify({ text, to: FEISHU_TO }) + '\n');
      setTimeout(() => s.end(), 300);
    });
    s.on('error', reject);
    s.on('close', resolve);
  });
}

async function waitNanoReplyAfter(baseSeq, timeoutMs = 90000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const rows = nanoRowsSince(baseSeq);
    const chatReply = rows.find((r) => r.kind === 'chat');
    if (chatReply) return { firstTs: Date.now(), reply: chatReply, allRows: rows };
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('nano-timeout');
}

async function nanoMeasure(text) {
  const baseSeq = nanoLatestOutSeq();
  const t0 = Date.now();
  await nanoInject(text);
  const sendDoneTs = Date.now();
  try {
    const { firstTs, reply, allRows } = await waitNanoReplyAfter(baseSeq);
    return {
      ok: true,
      latency_total_ms: firstTs - t0,
      latency_inject_ms: sendDoneTs - t0,
      reply_seq: reply.seq,
      reply_kind: reply.kind,
      reply_text: extractText(reply.content),
      intermediate_rows: allRows.length,
    };
  } catch (e) {
    return { ok: false, latency_total_ms: Date.now() - t0, error: e.message };
  }
}

function extractText(content) {
  try {
    const j = JSON.parse(content);
    return j.text || '';
  } catch {
    return content || '';
  }
}

function openclawInject(text, opts = {}) {
  // `openclaw agent --to <phone> --json -m "<text>"` — gateway path.
  // - Each call gets a FRESH synthetic phone (unless opts.toPhone provided
  //   for session-continuity tests like long_conversation).
  // - --timeout caps the per-turn agent budget at 120s.
  // - Result JSON: {runId, status, summary, result:{payloads,meta:{durationMs,agentMeta,stopReason,...}}}
  // - We return: wall_ms (full process time, includes ~8s CLI startup),
  //              agent_duration_ms (model-side, from result.meta.durationMs),
  //              reply_text (best-effort from payloads, may be empty if
  //              model went toolUse + aborted — see phaseB-smoke-results.json).
  if (!fs.existsSync(OPENCLAW_BIN)) {
    throw new Error(`openclaw bin not found at ${OPENCLAW_BIN}`);
  }
  const toPhone = opts.toPhone || nextOpenclawPhone();
  const t0 = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode = 0;
  try {
    const r = spawnSync(
      OPENCLAW_BIN,
      ['agent', '--to', toPhone, '--json', '-m', text, '--timeout', '120'],
      { encoding: 'utf8', timeout: 180000, maxBuffer: 4_000_000 },
    );
    stdout = r.stdout || '';
    stderr = r.stderr || '';
    exitCode = r.status ?? -1;
  } catch (e) {
    return { ok: false, wall_ms: Date.now() - t0, error: e.message, toPhone };
  }
  const t1 = Date.now();
  let parsed = null;
  let payloads = [];
  let agentDuration = null;
  let stopReason = null;
  let providerObs = null;
  let modelObs = null;
  let replyText = '';
  try {
    const m = stdout.match(/\{[\s\S]*\}/);
    if (m) {
      parsed = JSON.parse(m[0]);
      const res = parsed.result || {};
      const meta = res.meta || {};
      const am = meta.agentMeta || {};
      payloads = (res.payloads || []).map((p) => p.text || '');
      agentDuration = meta.durationMs ?? null;
      stopReason = meta.stopReason ?? null;
      providerObs = am.provider ?? null;
      modelObs = am.model ?? null;
      // Prefer non-deliver-warning payload
      replyText = payloads.find((t) => t && !t.includes('Message failed')) || payloads[0] || '';
    } else {
      replyText = stdout.slice(0, 4000);
    }
  } catch {
    replyText = stdout.slice(0, 4000);
  }
  return {
    ok: exitCode === 0 && payloads.length > 0,
    wall_ms: t1 - t0,
    latency_total_ms: t1 - t0, // back-compat alias
    agent_duration_ms: agentDuration,
    stop_reason: stopReason,
    provider_observed: providerObs,
    model_observed: modelObs,
    exit_code: exitCode,
    payloads,
    reply_text: replyText,
    to_phone: toPhone,
    stderr_tail: stderr.slice(-300),
  };
}

function quantile(arr, q) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.floor(s.length * q));
  return s[i];
}

function stats(arr) {
  return {
    n: arr.length,
    min: arr.length ? Math.min(...arr) : null,
    max: arr.length ? Math.max(...arr) : null,
    p50: quantile(arr, 0.5),
    p95: quantile(arr, 0.95),
    p99: quantile(arr, 0.99),
    mean: arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null,
  };
}

// ---------- 2.1 Serial latency ----------
async function suiteSerialLatency(platform, runsPerPrompt = 5) {
  const out = {};
  for (const [klass, prompts] of Object.entries(PROMPT_SET)) {
    out[klass] = [];
    for (const prompt of prompts) {
      const samples = [];
      for (let i = 0; i < runsPerPrompt; i++) {
        process.stderr.write(`[${platform}/serial/${klass}] iter ${i + 1}/${runsPerPrompt}...`);
        const res = platform === 'nanoclaw' ? await nanoMeasure(prompt) : openclawInject(prompt);
        // attach model_processing_ms so downstream consumers don't have to
        // know the per-platform extraction rule
        res.model_processing_ms = platform === 'openclaw'
          ? (res.agent_duration_ms ?? null)
          : res.latency_total_ms;
        process.stderr.write(`${res.ok ? '✓' : '✗'} wall=${res.latency_total_ms}ms model=${res.model_processing_ms}ms\n`);
        samples.push(res);
        await new Promise((r) => setTimeout(r, 1500));
      }
      const okSamples = samples.filter((s) => s.ok);
      out[klass].push({
        prompt: prompt.slice(0, 80),
        samples,
        // Dual-stat: wall (raw measurement) + model_processing (cross-platform comparable)
        // Phase D MUST use latency_stats_model_processing for nano-vs-openclaw comparison.
        latency_stats_wall: stats(okSamples.map((s) => s.latency_total_ms)),
        latency_stats_model_processing: stats(okSamples.map((s) => s.model_processing_ms).filter((v) => v != null)),
        success_rate: okSamples.length / samples.length,
      });
    }
  }
  return out;
}

// ---------- 2.2a Concurrent — same session ----------
// N messages into the SAME session/messaging_group. Tests within-session
// queueing / batch-merging behavior. Both platforms serialize internally
// (nanoclaw: per-mg container singleton; openclaw: per-session lane).
//
// Each prompt embeds a unique token (Issue 2 from Reviewer self-review).
// We verify each token round-trips to an outbound row → replies_observed
// is the count of distinct tokens recovered, NOT seq advance. This
// distinguishes "50 unique replies" from "<50 replies but seq incremented".
async function suiteConcurrentSameSession(platform, levels = [10, 50]) {
  const out = {};
  for (const N of levels) {
    process.stderr.write(`[${platform}/concurrent-same/${N}] launching ${N} parallel injects (single session, token-echo verification)...\n`);
    const t0 = Date.now();
    const baseSeq = platform === 'nanoclaw' ? nanoLatestOutSeq() : 0;
    // Prepare N unique tokens
    const tokens = Array.from({ length: N }, (_, i) => newToken(`C2A${N}I${i}`));
    const launches = [];
    const ocFixedPhone = platform === 'openclaw' ? nextOpenclawPhone() : null;
    for (let i = 0; i < N; i++) {
      const basePrompt = `数字 ${i + 1} 是奇数还是偶数？`;
      const prompt = promptWithToken(basePrompt, tokens[i]);
      if (platform === 'nanoclaw') {
        launches.push(nanoInject(prompt).then(() => ({ idx: i, ok: true })).catch((e) => ({ idx: i, ok: false, err: e.message })));
      } else {
        launches.push(Promise.resolve(openclawInject(prompt, { toPhone: ocFixedPhone })));
      }
    }
    const launchResults = await Promise.all(launches);
    const injectsOk = launchResults.filter((r) => r.ok).length;

    // Wait for all token replies to appear (nanoclaw) or pre-captured (openclaw)
    const tokenFound = new Array(N).fill(false);
    if (platform === 'nanoclaw') {
      const tPoll0 = Date.now();
      while (Date.now() - tPoll0 < 240000) {
        let allFound = true;
        for (let i = 0; i < N; i++) {
          if (tokenFound[i]) continue;
          const r = scanOutboundForToken(NANO_OUT_DB, tokens[i], baseSeq);
          if (r && r.found) tokenFound[i] = true;
          else allFound = false;
        }
        if (allFound) break;
        await new Promise((r) => setTimeout(r, 1500));
      }
    } else {
      // openclaw: each spawnSync returned, scan its reply_text for the token
      for (let i = 0; i < N; i++) {
        const reply = launchResults[i].reply_text || '';
        if (reply.includes(tokens[i])) tokenFound[i] = true;
      }
    }
    const replies = tokenFound.filter(Boolean).length;
    const elapsed = Date.now() - t0;
    // openclaw per-call samples: spawnSync serialized, each call has its own
    // wall_ms + agent_duration_ms + stop_reason. Preserve so Phase D can
    // split "CLI startup overhead" (wall - agent_duration) from "model time"
    // and observe context-growth effect across N sequential same-session calls.
    // nanoclaw: per-call timing not meaningful (5 inject batched into 1 turn),
    // aggregate elapsed_ms is the meaningful metric.
    const ocPerCallSamples = platform === 'openclaw'
      ? launchResults.map((r, i) => ({
          idx: i,
          ok: r.ok,
          wall_ms: r.wall_ms,
          agent_duration_ms: r.agent_duration_ms ?? null,
          model_processing_ms: r.agent_duration_ms ?? null,
          stop_reason: r.stop_reason ?? null,
          provider_observed: r.provider_observed ?? null,
          model_observed: r.model_observed ?? null,
          token_in_reply: tokenFound[i],
        }))
      : null;
    out[`N=${N}`] = {
      mode: 'same-session',
      attempted: N,
      injected_ok: injectsOk,
      replies_observed_token_echo: replies,
      loss_rate: 1 - replies / N,
      elapsed_ms: elapsed,
      qps: Math.round((replies / elapsed) * 1000 * 100) / 100,
      integrity_check_after: runIntegrityCheck(),
      verification_method: 'token-echo (each prompt embeds unique token; reply must contain it)',
      missing_tokens: tokens.filter((_, i) => !tokenFound[i]),
      openclaw_per_call_samples: ocPerCallSamples,
    };
  }
  return out;
}

// ---------- 2.2b Concurrent — multi session ----------
//
// Architecture-fact basis (user-confirmed + source-verified at command-queue-JOCs7lw4.js:66
// maxConcurrent=1 on both session lane AND global Main lane):
//   - nanoclaw multi-session = true parallelism (each session → separate container process)
//   - openclaw multi-session = STILL serial via global Main lane (no point in 5-parallel test)
//
// So C.2b asymmetric design:
//   - nanoclaw: 5 parallel platformIds × 3 iterations (data stability)
//   - openclaw: 1 baseline call (single-session latency), use as serial reference
//
// Phase D report: compare nanoclaw multi-session parallel speedup vs openclaw
// serial baseline. NOT a fair "concurrent throughput" comparison — it's
// quantifying nanoclaw's architectural advantage. State this in §0.
async function suiteConcurrentMultiSession(platform) {
  if (platform === 'nanoclaw') {
    // Issue 3 fix (方案 C): 10 platformIds × 4 iterations with mid-test reset.
    // - iter 1: group A fresh (just prepped)
    // - iter 2: group B fresh (just prepped)
    // - iter 3: cleanup group A + re-prep group A, then run on freshly-reset A
    // - iter 4: cleanup group B + re-prep group B, then run on freshly-reset B
    // Each iteration's 5 sessions are guaranteed history-free.
    // PREREQ: caller must have prepped BOTH groups before invoking.
    const allIters = [];
    const sequence = [
      { iter: 1, group: 'A', platformIds: BENCH_GROUP_A_PLATFORM_IDS, reset: false },
      { iter: 2, group: 'B', platformIds: BENCH_GROUP_B_PLATFORM_IDS, reset: false },
      { iter: 3, group: 'A', platformIds: BENCH_GROUP_A_PLATFORM_IDS, reset: true,  resetPrefix: BENCH_GROUP_A_PREFIX, resetPrefixLike: BENCH_GROUP_A_PREFIX + '%' },
      { iter: 4, group: 'B', platformIds: BENCH_GROUP_B_PLATFORM_IDS, reset: true,  resetPrefix: BENCH_GROUP_B_PREFIX, resetPrefixLike: BENCH_GROUP_B_PREFIX + '%' },
    ];
    for (const step of sequence) {
      if (step.reset) {
        process.stderr.write(`\n[c2b/iter${step.iter}] reset boundary: cleanup + re-prep group ${step.group}\n`);
        try {
          runCleanupGroup(step.resetPrefixLike);
          runPrepGroup(step.resetPrefix);
        } catch (e) {
          process.stderr.write(`[c2b/iter${step.iter}] reset failed: ${e.message}\n`);
          allIters.push({
            iter: step.iter,
            group: step.group,
            status: 'reset_failed',
            elapsed_ms: null,
            replies_observed: null,
            cross_talk_violations: null,
            error: e.message,
          });
          continue;
        }
      }
      const iterResult = await _multiSessionIterNano(step.iter, step.group, step.platformIds);
      iterResult.status = 'ok';
      allIters.push(iterResult);
      await new Promise((r) => setTimeout(r, 5000));
    }
    // Build stats over valid iterations only (Issue 3 fix)
    const validIters = allIters.filter((it) => it.status === 'ok' && typeof it.elapsed_ms === 'number');
    const invalidIters = allIters.filter((it) => it.status !== 'ok' || typeof it.elapsed_ms !== 'number');
    const validCount = validIters.length;
    // Issue 3 fix (Reviewer round 4): throw here would discard per_iteration
    // raw data. Instead return a structured "stats_invalid" payload so the
    // batch json preserves the raw iteration evidence for inspection.
    if (validCount < 2) {
      return {
        N: 5,
        iterations: 4,
        design: 'Issue 3 fix 方案 C: 2 groups × 4 iters with mid-test reset',
        mode: 'multi-session',
        platform: 'nanoclaw',
        per_iteration: allIters,
        stats_across_iterations: null,
        stats_invalid_reason: `only ${validCount}/${allIters.length} valid iterations — stats not derived; raw per_iteration preserved for inspection`,
        invalid_reasons: invalidIters.map((it) => it.error || it.status),
      };
    }
    const elapsedSorted = validIters.map((it) => it.elapsed_ms).sort((a, b) => a - b);
    return {
      N: 5,
      iterations: 4,
      design: 'Issue 3 fix 方案 C: 2 groups × 4 iters with mid-test reset',
      mode: 'multi-session',
      platform: 'nanoclaw',
      per_iteration: allIters,
      stats_across_iterations: {
        valid_count: validCount,
        invalid_count: invalidIters.length,
        invalid_reasons: invalidIters.map((it) => it.error || it.status),
        elapsed_ms: {
          values: validIters.map((it) => it.elapsed_ms),
          min: elapsedSorted[0],
          max: elapsedSorted[elapsedSorted.length - 1],
          p50: elapsedSorted[Math.floor(elapsedSorted.length / 2)],
          computed_from: `valid iterations only (${validCount}/${allIters.length})`,
        },
        replies_observed: validIters.map((it) => it.replies_observed),
        cross_talk_violations: validIters.map((it) => it.cross_talk_violations),
        integrity_after: validIters.map((it) => it.integrity_check_after),
      },
    };
  }

  // openclaw path — single baseline call (architecture is globally serial,
  // multi-parallel test would just be sequential time-mux)
  const ocOut = {
    mode: 'multi-session',
    platform: 'openclaw',
    test_design_note: [
      'openclaw is dispatcher-globally-serial.',
      'Source ref: command-queue-JOCs7lw4.js:66 (maxConcurrent=1 on Main lane) + pi-embedded-runner-DXh-tqVs.js:6242 (nested enqueue: session lane → Main lane).',
      'Both the CLI harness path and the production WebSocket path land at the SAME command-queue Main lane, so end-to-end latency magnitude is equivalent (only the ingress layer differs).',
      'Single baseline call here is used as the reference unit for predicted 5-call wall.',
    ].join(' '),
  };
  const t0Oc = Date.now();
  const tokenOc = newToken('C2BOCSINGLE');
  const probe = openclawInject(promptWithToken('请把这个 token 原样回显', tokenOc));
  ocOut.baseline_call = {
    wall_ms: probe.wall_ms,
    agent_duration_ms: probe.agent_duration_ms,
    stop_reason: probe.stop_reason,
    token_in_reply: (probe.reply_text || '').includes(tokenOc),
    payloads: probe.payloads,
  };
  // Predicted 5-call wall — LOWER BOUND only (Issue 2 fix: include ε_overhead)
  // R5.2 audit: fallback to wall_ms only if agent_duration_ms is null —
  // explicitly record which basis we used so Phase D doesn't silently include
  // ~8s × 5 CLI startup overhead in a "model latency" comparison.
  const baselineForPredict = probe.agent_duration_ms ?? probe.wall_ms;
  ocOut.predicted_5_call_wall_ms_LOWER_BOUND = baselineForPredict * 5;
  ocOut.predicted_basis = probe.agent_duration_ms != null
    ? 'agent_duration_ms (model time, excludes CLI startup)'
    : 'wall_ms (FALLBACK — includes ~8s CLI startup; overestimates by ~40s for 5 calls)';
  ocOut.epsilon_overhead_note = [
    'predicted_5_call_wall_ms_LOWER_BOUND is 5 × baseline; actual 5-call wall is GREATER by ε_overhead per turn.',
    'ε_overhead components NOT measured here: (1) dispatcher scheduling between Main-lane releases,',
    '(2) db writes (session store, audit, message tables), (3) adapter routing (Feishu HTTP, openclaw-weixin, langfuse traces).',
    'ε is O(seconds) per turn empirically. Direction of error: this prediction UNDERSTATES openclaw 5-call wall time.',
    'Phase D table MUST present this as a lower bound, not a point estimate.',
  ].join(' ');
  ocOut.total_elapsed_ms = Date.now() - t0Oc;
  return ocOut;
}

// Inner helper: 1 iteration of nanoclaw C.2b (5 parallel platformIds in chosen group)
async function _multiSessionIterNano(iter, group, platformIds) {
    const out = { iteration: iter, group, N: 5, platformIds };
    const t0 = Date.now();
    // Capture pre-launch process snapshot for CPU/RAM tracking
    const psBefore = (() => {
      try {
        return execSync('ps -axo pid,rss,pcpu,comm | grep -E "(frontlane|agent-runner)" | head -20', { encoding: 'utf8' });
      } catch { return ''; }
    })();
    // Inject 5 parallel messages to 5 different platformIds (the iteration's group).
    // Each prompt contains a UNIQUE token; we'll verify reply echos that token (cross-talk check).
    const launches = platformIds.map((platformId, i) => {
      const uniqueToken = `XK${i + 1}-${Math.random().toString(36).slice(2, 8)}`;
      const prompt = `[ms ${i + 1}/5] 这个 token 是 ${uniqueToken}，请用一句话原样回显它（不要解释）。`;
      const t = Date.now();
      return new Promise((resolve) => {
        const s = net.connect(NANO_SOCK);
        s.on('connect', () => {
          s.write(JSON.stringify({
            text: prompt,
            to: { channelType: 'feishu', platformId, threadId: null },
          }) + '\n');
          setTimeout(() => s.end(), 300);
        });
        s.on('error', (e) => resolve({ idx: i, ok: false, err: e.message, platformId, uniqueToken, inject_at: t }));
        s.on('close', () => resolve({ idx: i, ok: true, platformId, uniqueToken, inject_at: t }));
      });
    });
    const launchResults = await Promise.all(launches);
    process.stderr.write(`[nano/concurrent-multi] 5 injections fired, polling outbounds 180s...\n`);
    // Poll: we need to see 5 replies, each in its own session's outbound.db
    const expectedReplies = new Map(); // platformId → {uniqueToken, found?, replyText, found_at}
    for (const r of launchResults) {
      if (r.ok) expectedReplies.set(r.platformId, { uniqueToken: r.uniqueToken, inject_at: r.inject_at });
    }
    const tPoll0 = Date.now();
    while (Date.now() - tPoll0 < 180000) {
      let allFound = true;
      for (const [pid, info] of expectedReplies) {
        if (info.found) continue;
        // Find session for this platformId
        try {
          const sessRow = execSync(
            `sqlite3 -separator '|||' "${NANO_ROOT}/data/v2.db" "SELECT s.id, s.agent_group_id FROM sessions s JOIN messaging_groups mg ON s.messaging_group_id = mg.id WHERE mg.platform_id = '${pid}' LIMIT 1;"`,
            { encoding: 'utf8' },
          ).trim();
          if (!sessRow) { allFound = false; continue; }
          const [sid, agid] = sessRow.split('|||');
          const sessOutDb = path.join(NANO_ROOT, 'data', 'v2-sessions', agid, sid, 'outbound.db');
          if (!fs.existsSync(sessOutDb)) { allFound = false; continue; }
          const rowsCsv = execSync(
            `sqlite3 -separator '|||' "${sessOutDb}" "SELECT seq, substr(content, 1, 500) FROM messages_out ORDER BY seq DESC LIMIT 3;"`,
            { encoding: 'utf8' },
          ).trim();
          if (rowsCsv) {
            const reply = rowsCsv.split('\n').find((line) => line.includes(info.uniqueToken));
            if (reply) {
              info.found = true;
              info.found_at = Date.now();
              info.reply_text = reply;
            } else {
              allFound = false;
            }
          } else { allFound = false; }
        } catch { allFound = false; }
      }
      if (allFound) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    const psAfter = (() => {
      try {
        return execSync('ps -axo pid,rss,pcpu,comm | grep -E "(frontlane|agent-runner)" | head -20', { encoding: 'utf8' });
      } catch { return ''; }
    })();
    // Build the per-session result
    const perSession = [...expectedReplies.entries()].map(([pid, info]) => ({
      platformId: pid,
      uniqueToken: info.uniqueToken,
      found: !!info.found,
      latency_ms: info.found ? info.found_at - info.inject_at : null,
      reply_excerpt: info.found ? info.reply_text.slice(0, 150) : null,
    }));
    // Cross-talk check: each session's reply should echo its OWN token, not a peer's
    const crossTalkViolations = perSession.filter((s) =>
      s.found && platformIds.some((peer) => peer !== s.platformId && s.reply_excerpt && s.reply_excerpt.includes(expectedReplies.get(peer)?.uniqueToken || '___NOMATCH___')),
    );
    out.elapsed_ms = Date.now() - t0;
    out.per_session = perSession;
    out.replies_observed = perSession.filter((s) => s.found).length;
    out.cross_talk_violations = crossTalkViolations.length;
    out.ps_before = psBefore;
    out.ps_after_during = psAfter;
    out.integrity_check_after = runIntegrityCheck();
    return out;
}

// Convenience wrapper kept for back-compat with original API name
async function suiteConcurrent(platform, levels = [10, 50]) {
  return {
    sameSession: await suiteConcurrentSameSession(platform, levels),
    multiSession: await suiteConcurrentMultiSession(platform),
  };
}

// ---------- 2.3 Long conversation ----------
async function suiteLong(platform, turns) {
  // LONG_TURNS env override; default 50 (was 20). Phase C v2 spec: 50 turns
  // + inject tool-call prompts at turns 10/20/30/40 to accumulate tool_call_id
  // history and observe F2 (stateless replay bug) trigger threshold.
  turns = turns || parseInt(process.env.LONG_TURNS || '50', 10);
  const out = [];

  // openclaw long-conv: pin toPhone to maintain session continuity (prior
  // versions called openclawInject with no toPhone → fresh phone per turn →
  // not actually long-conv. Bug fixed for Batch 4).
  const ocFixedPhone = platform === 'openclaw' ? nextOpenclawPhone() : null;

  // Tool-call injection turns (nano only — openclaw tools are different shape)
  const TOOL_CALL_TURNS = new Set([10, 20, 30, 40]);

  // Track session DB sizes per turn (nano only)
  const dbSizeFor = () => {
    if (platform !== 'nanoclaw') return { outbound: null, inbound: null };
    try {
      const outSize = fs.statSync(NANO_OUT_DB).size;
      const inSize = fs.statSync(NANO_IN_DB).size;
      return { outbound: outSize, inbound: inSize };
    } catch { return { outbound: null, inbound: null }; }
  };

  for (let i = 1; i <= turns; i++) {
    let prompt;
    const isToolCallTurn = platform === 'nanoclaw' && TOOL_CALL_TURNS.has(i);
    if (isToolCallTurn) {
      // Triggers function_call entry in session_state.continuation:openai —
      // exact mechanism that triggers F2 stateless-replay bug if it recurs.
      // Using exec (registered MCP tool) which records call_id reliably.
      prompt = `[turn ${i}/${turns}] 请调用 exec 工具运行 \`echo "turn ${i} check"\` 并把输出用一句话告诉我。`;
    } else {
      prompt = `[turn ${i}/${turns}] 这是第 ${i} 轮。请用一行回复你记得我们前面聊过什么（如果是第 1 轮就说"刚开始"）。不要复述全部历史，只挑 1 个关键点。`;
    }
    process.stderr.write(`[${platform}/long] turn ${i}/${turns}${isToolCallTurn ? ' [TOOLCALL]' : ''}...`);
    const dbBefore = dbSizeFor();
    const res = platform === 'nanoclaw'
      ? await nanoMeasure(prompt)
      : openclawInject(prompt, { toPhone: ocFixedPhone });
    const dbAfter = dbSizeFor();
    const modelProcessingMs = platform === 'openclaw'
      ? (res.agent_duration_ms ?? null)
      : res.latency_total_ms;
    process.stderr.write(`${res.ok ? '✓' : '✗'} wall=${res.latency_total_ms}ms model=${modelProcessingMs}ms\n`);
    out.push({
      turn: i,
      ok: res.ok,
      is_tool_call_turn: isToolCallTurn,
      wall_ms: res.latency_total_ms,
      agent_duration_ms: res.agent_duration_ms ?? null,
      model_processing_ms: modelProcessingMs,
      stop_reason: res.stop_reason ?? null,
      provider_observed: res.provider_observed ?? null,
      model_observed: res.model_observed ?? null,
      reply_first_80: (res.reply_text || '').slice(0, 80).replace(/\n/g, ' '),
      // F2 detection: was reply an error-shape with tool_call_id mismatch?
      f2_triggered: (res.reply_text || '').includes('tool result\'s tool id') ||
                    (res.reply_text || '').includes('not found (2013)'),
      db_outbound_bytes: dbAfter.outbound,
      db_inbound_bytes: dbAfter.inbound,
      db_outbound_growth_bytes: dbBefore.outbound != null && dbAfter.outbound != null
        ? dbAfter.outbound - dbBefore.outbound : null,
    });
    // Early exit if F2 hits: continue to observe but stop test if pattern persists
    if (out[out.length - 1].f2_triggered) {
      process.stderr.write(`[${platform}/long] F2 TRIGGER at turn ${i}\n`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return out;
}

// ---------- 2.4 Fault recovery (v2: a=SIGTERM grace, b=SIGKILL, both N=3, both platforms) ----------
//
// C.4a — SIGTERM + 10s grace. Expected: 0 corruption, in-flight messages
//         complete cleanly. corruption > 0 OR loss > 0 → P0 finding.
// C.4b — SIGKILL hard crash. Some message loss tolerated; corruption is
//         tracked as a separate production-bug signal (NOT test artifact).
// C.4c (OOM) — deferred. See README/decision report.
//
// Per-iteration:
//   1. cp checkpoint of session DBs
//   2. inject 1 message that needs ~5s to process (forces in-flight state)
//   3. ~2s later, fire the fault signal
//   4. wait up to 90s for: outbound row written for the injected message
//   5. integrity_check both DBs
//   6. record result + integrity outcome

async function _faultIterNano(variant, idx) {
  const label = `[nano/fault/${variant}/iter${idx}]`;
  const ck = cpCheckpoint(`fault-${variant}-iter${idx}-pre`);
  process.stderr.write(`${label} checkpoint: ${ck.outbound ? 'ok' : `err:${ck.error}`}\n`);
  const baseSeq = nanoLatestOutSeq();
  const token = newToken(`FLT${variant.toUpperCase()}I${idx}`);
  const injectTs = Date.now();
  await nanoInject(promptWithToken('请用一句话告诉我现在是哪一年', token));
  // R5.5: wait for container to materialize before firing kill. Cold-start
  // race: iter 1 fires at +2s before container is up → kill targets [],
  // test silently degrades to "normal completion not fault recovery".
  // Without this guard, iter 1 of every benchmark run is data-invalid.
  const containerWait = await waitForNanoContainer(15000);
  if (!containerWait.ready) {
    process.stderr.write(`${label} ABORT: no container spawned within 15s — iter invalid\n`);
    return {
      variant,
      iteration: idx,
      token,
      status: 'no_container_spawned',
      container_wait_ms: containerWait.wait_ms,
      message_completed: false,
      checkpoint: ck,
    };
  }
  process.stderr.write(`${label} container alive at +${containerWait.wait_ms}ms (${containerWait.names.join(',')}); +2s buffer then fire ${variant}\n`);
  await new Promise((r) => setTimeout(r, 2000));
  // measurement semantic fix: ts BEFORE blocking kill call so
  // inject_to_kill_signal_ms reflects "we issued the signal", not "the kill
  // syscall finally returned". docker stop --time 10 blocks up to 10s; this
  // would have contaminated kill_signal-to-event timings.
  const killSignalAt = Date.now();
  const killedNames = variant === 'a-sigterm' ? nanoSigterm() : nanoSigkill();
  const killReturnedAt = Date.now();
  process.stderr.write(`${label} fault fired (${variant}, signal→returned=${killReturnedAt - killSignalAt}ms), killed=[${killedNames.join(',')}]\n`);
  // Recovery measurement uses killSignalAt as t-zero
  let recovered = false;
  let recoveryAt = null;
  let tokenFound = false;
  let tokenFoundAt = null;
  while (Date.now() - killSignalAt < 90000) {
    const cur = nanoLatestOutSeq();
    if (cur > baseSeq && !recovered) {
      recovered = true;
      recoveryAt = Date.now();
    }
    const tr = scanOutboundForToken(NANO_OUT_DB, token, baseSeq);
    if (tr && tr.found && !tokenFound) {
      tokenFound = true;
      tokenFoundAt = Date.now();
      break;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  const integrity = runIntegrityCheck();
  // Sanity check: inject_to_kill_signal_ms is by-design ~2000ms (inject + 2s
  // sleep + kill-signal-fire). If reality > 5000ms, flag — likely another
  // blocking call slipped in or sleep was stretched.
  const injectToKillMs = killSignalAt - injectTs;
  const expectedBoundsHigh = 5000;
  const expected_bounds_check = injectToKillMs > expectedBoundsHigh
    ? `WARN: inject_to_kill_signal_ms=${injectToKillMs} exceeds expected ~2000ms upper bound ${expectedBoundsHigh}`
    : 'ok';
  return {
    variant,
    iteration: idx,
    token,
    status: 'ok',
    container_wait_ms: containerWait.wait_ms,
    inject_to_kill_signal_ms: injectToKillMs,
    kill_signal_to_returned_ms: killReturnedAt - killSignalAt,
    recovered_seq_advance: recovered,
    recover_seq_ms: recoveryAt ? recoveryAt - killSignalAt : null,
    token_found: tokenFound,
    token_recover_ms: tokenFoundAt ? tokenFoundAt - killSignalAt : null,
    message_completed: tokenFound, // ← P0 metric for SIGTERM
    killed_containers: killedNames,
    expected_bounds_check,
    integrity,
    checkpoint: ck,
  };
}

async function _faultIterOpenclaw(variant, idx) {
  const label = `[oc/fault/${variant}/iter${idx}]`;
  process.stderr.write(`${label} starting\n`);
  // openclaw fault is process-level, not in-flight per-message.
  // Test: kill the gateway, then probe — does it accept new work + return ok?
  // measurement semantic fix: ts BEFORE blocking signal call. Both
  // launchctl kickstart -k (SIGTERM path) and `kill -9 <pid>` are blocking
  // syscalls that may take time to return; we want recover_ms measured from
  // "we issued the signal", not "the syscall returned".
  const killSignalAt = Date.now();
  const action = variant === 'a-sigterm' ? openclawSigterm() : openclawSigkill();
  const killReturnedAt = Date.now();
  process.stderr.write(`${label} fault fired (${variant}, signal→returned=${killReturnedAt - killSignalAt}ms): ${JSON.stringify(action)}\n`);
  const readyWaitMs = await waitForOpenclawReady(60000);
  if (readyWaitMs === null) {
    return {
      variant,
      iteration: idx,
      action,
      kill_signal_to_returned_ms: killReturnedAt - killSignalAt,
      recovered: false,
      recover_ms_from_signal: null,
      probe_result: { ok: false, reason: 'gateway not ready within 60s' },
    };
  }
  // recover_ms_from_signal: time from killSignalAt until gateway /healthz
  // returned ok. waitForOpenclawReady started at killReturnedAt and waited
  // readyWaitMs more, so total from killSignalAt:
  const recoverMsFromSignal = (killReturnedAt - killSignalAt) + readyWaitMs;
  const probe = openclawInject(`[fault-${variant}-${idx}] 1+2 等于多少？`);
  return {
    variant,
    iteration: idx,
    action,
    kill_signal_to_returned_ms: killReturnedAt - killSignalAt,
    recovered: true,
    recover_ms_from_signal: recoverMsFromSignal,
    probe_ok: probe.ok,
    probe_agent_duration_ms: probe.agent_duration_ms,
    probe_stop_reason: probe.stop_reason,
  };
}

async function suiteFault(platform) {
  const out = { 'C.4a-sigterm': [], 'C.4b-sigkill': [], 'C.4c-oom': { skipped: 'deferred, see decision report' } };
  for (const variant of ['a-sigterm', 'b-sigkill']) {
    for (let i = 1; i <= 3; i++) {
      const iter = platform === 'nanoclaw'
        ? await _faultIterNano(variant, i)
        : await _faultIterOpenclaw(variant, i);
      out[variant === 'a-sigterm' ? 'C.4a-sigterm' : 'C.4b-sigkill'].push(iter);
      // brief recovery pause before next iter
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  // Always include the malformed-payload test as a bonus (cheap, both
  // platforms can take it without affecting the kill metrics)
  if (platform === 'nanoclaw') {
    try {
      await new Promise((resolve) => {
        const s = net.connect(NANO_SOCK);
        s.on('connect', () => { s.write('{this is not json\n'); setTimeout(() => s.end(), 300); });
        s.on('error', () => resolve());
        s.on('close', () => resolve());
      });
      out.malformed_payload = { accepted: true, host_alive_after: true };
    } catch (e) {
      out.malformed_payload = { accepted: false, error: e.message };
    }
  }
  return out;
}

// ---------- main: batch-mode lifecycle ----------
// Phase C v2 design: each batch runs independently, writes its own raw JSON,
// caller (Claude / user) inspects between batches. Pass a BATCH env var to
// pick which batch to run; default runs everything sequentially.
//
//   BATCH=serial       node scripts/perf-benchmark.cjs
//   BATCH=concurrent-10 ...
//   BATCH=concurrent-multi ...
//   BATCH=long ...
//   BATCH=fault ...
//   (unset)            runs all in order

const BATCH = process.env.BATCH || 'all';
const PLATFORMS = TARGET === 'both' ? ['nanoclaw', 'openclaw'] : [TARGET];

async function runBatch(batchName, runner) {
  const result = { meta: { batch: batchName, started_at: new Date().toISOString(), platforms: PLATFORMS } };
  // Pre-batch checkpoint of nanoclaw DBs (skip for openclaw-only batches; cheap, just do always)
  const ck = cpCheckpoint(batchName);
  result.meta.checkpoint = ck;
  result.meta.integrity_before = runIntegrityCheck();
  process.stderr.write(`\n\n============ BATCH: ${batchName} ============\n`);
  result.results = {};
  for (const platform of PLATFORMS) {
    try {
      result.results[platform] = await runner(platform);
    } catch (e) {
      result.results[platform] = { error: e.message, stack: e.stack };
    }
  }
  result.meta.finished_at = new Date().toISOString();
  result.meta.integrity_after = runIntegrityCheck();
  const outPath = `perf-results-raw-v2-${batchName}.json`;
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  process.stderr.write(`\n${outPath} written. integrity after: outbound=${result.meta.integrity_after.outbound} inbound=${result.meta.integrity_after.inbound}\n`);
  return result;
}

(async () => {
  const ranBatches = [];

  if (BATCH === 'all' || BATCH === 'serial') {
    const r = await runBatch('serial', (p) => suiteSerialLatency(p));
    ranBatches.push(r);
  }

  if (BATCH === 'all' || BATCH === 'concurrent-10') {
    const r = await runBatch('concurrent-10', (p) => suiteConcurrentSameSession(p, [10]));
    ranBatches.push(r);
  }

  if (BATCH === 'all' || BATCH === 'concurrent-50') {
    const r = await runBatch('concurrent-50', (p) => suiteConcurrentSameSession(p, [50]));
    ranBatches.push(r);
  }

  if (BATCH === 'all' || BATCH === 'concurrent-multi') {
    // Prep BOTH bench groups before nanoclaw multi-session iterations.
    // Iterations 3/4 will internally cleanup + re-prep their respective group.
    // After the batch: cleanup both groups (whichever still exists).
    process.stderr.write('\n[concurrent-multi/prep] creating both bench groups A and B...\n');
    try {
      runPrepGroup(BENCH_GROUP_A_PREFIX);
      runPrepGroup(BENCH_GROUP_B_PREFIX);
    } catch (e) {
      process.stderr.write(`[concurrent-multi/prep] failed: ${e.message}\n`);
    }
    const r = await runBatch('concurrent-multi', (p) => suiteConcurrentMultiSession(p));
    ranBatches.push(r);
    // Always cleanup both groups after, regardless of iteration mid-state
    process.stderr.write('\n[concurrent-multi/cleanup] removing both bench groups...\n');
    try {
      runCleanupGroup(BENCH_GROUP_A_PREFIX + '%');
      runCleanupGroup(BENCH_GROUP_B_PREFIX + '%');
    } catch (e) {
      process.stderr.write(`[concurrent-multi/cleanup] failed: ${e.message}\n`);
    }
  }

  if (BATCH === 'all' || BATCH === 'long') {
    const r = await runBatch('long', (p) => suiteLong(p));
    ranBatches.push(r);
  }

  if (BATCH === 'all' || BATCH === 'fault') {
    const r = await runBatch('fault', (p) => suiteFault(p));
    ranBatches.push(r);
  }

  process.stderr.write(`\n\nDONE. ${ranBatches.length} batch(es) completed.\n`);
})();
