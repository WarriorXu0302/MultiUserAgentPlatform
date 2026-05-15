#!/usr/bin/env -S node --experimental-strip-types
/**
 * scripts/log-trace.ts — render a single trace as an admin-readable timeline.
 *
 * Usage:
 *   pnpm log:trace <trace_id_or_prefix>           # render to stdout
 *   pnpm log:trace <prefix> > trace.md            # save to file
 *   pnpm log:trace <prefix> --plain               # no ANSI, plain text only
 *   pnpm log:trace <prefix> --raw                 # include full prompts/completions
 *
 * Aimed at the admin / on-call who got handed a trace_id and needs to know
 * what happened, without grepping multiple .log files or opening the dev UI.
 *
 * Reads from data/v2.db only — no host process required.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const idArg = args.find((a) => !a.startsWith('--'));
const flagPlain = args.includes('--plain') || !process.stderr.isTTY;
const flagRaw = args.includes('--raw');

if (!idArg) {
  console.error('Usage: pnpm log:trace <trace_id_or_prefix> [--plain] [--raw]');
  process.exit(1);
}

const REPO_ROOT = path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), '..');
const DB_PATH = path.join(REPO_ROOT, 'data', 'v2.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`v2.db not found at ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });

// ─── color helpers ──────────────────────────────────────────────────────────
const C = flagPlain
  ? { dim: '', reset: '', cyan: '', red: '', yellow: '', green: '', blue: '', magenta: '', bold: '' }
  : {
      dim: '\x1b[2m',
      reset: '\x1b[0m',
      cyan: '\x1b[36m',
      red: '\x1b[31m',
      yellow: '\x1b[33m',
      green: '\x1b[32m',
      blue: '\x1b[34m',
      magenta: '\x1b[35m',
      bold: '\x1b[1m',
    };

// ─── resolve trace_id prefix → full id ──────────────────────────────────────
const matched = db
  .prepare("SELECT DISTINCT trace_id FROM trace_events WHERE trace_id LIKE ? LIMIT 5")
  .all(`${idArg}%`) as Array<{ trace_id: string }>;

if (matched.length === 0) {
  console.error(`No trace_id matching prefix '${idArg}'`);
  process.exit(2);
}
if (matched.length > 1) {
  console.error(`Ambiguous prefix '${idArg}' — matches:`);
  for (const r of matched) console.error(`  ${r.trace_id}`);
  process.exit(3);
}
const traceId = matched[0].trace_id;

// ─── load spans ─────────────────────────────────────────────────────────────
interface Row {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_ts: number;
  end_ts: number | null;
  status: string | null;
  agent_group_id: string | null;
  session_id: string | null;
  attributes: string;
}
const spans = db
  .prepare('SELECT * FROM trace_events WHERE trace_id = ? ORDER BY start_ts, span_id')
  .all(traceId) as Row[];

if (spans.length === 0) {
  console.error(`trace_id ${traceId} resolved but has 0 spans (unexpected)`);
  process.exit(4);
}

// ─── render ─────────────────────────────────────────────────────────────────
function parseAttrs(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function fmtDur(start: number, end: number | null): string {
  if (end == null) return `${C.yellow}…in-flight${C.reset}`;
  const ms = end - start;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function fmtKind(kind: string): string {
  const palette: Record<string, string> = {
    'channel-inbound': C.blue,
    'agent-turn': C.magenta,
    'llm-generation': C.green,
    'llm-call': C.green,
    'tool-execution': C.yellow,
    'tool-exec': C.yellow,
    'a2a-hop': C.cyan,
    'channel-deliver': C.blue,
    'container-lifecycle': C.dim,
  };
  return `${palette[kind] ?? ''}${kind.padEnd(20)}${C.reset}`;
}

function fmtStatus(status: string | null): string {
  if (status === 'error') return `${C.red}✗ error${C.reset}`;
  if (status === 'abandoned') return `${C.yellow}? abandoned${C.reset}`;
  if (status === 'in_flight') return `${C.yellow}~ in_flight${C.reset}`;
  return `${C.green}✓ ok${C.reset}`;
}

function summarizeAttrs(kind: string, attrs: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const push = (k: string, v: unknown) => {
    if (v == null || v === '') return;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    lines.push(`    ${C.dim}${k.padEnd(20)}${C.reset} ${s}`);
  };

  switch (kind) {
    case 'channel-inbound':
      push('channel', attrs.channel ?? attrs.platform);
      push('user_id', attrs.user_id ?? attrs.userId);
      push('messageId', attrs.messageId);
      push('engage_mode', attrs.engage_mode);
      push('wake', attrs.wake);
      push('content_preview', attrs.content_preview);
      break;
    case 'agent-turn':
      push('provider', attrs.provider);
      push('message_count', attrs.message_count);
      push('batch_kinds', attrs.batch_kinds);
      break;
    case 'llm-generation':
    case 'llm-call':
      push('model', attrs['llm.model_name'] ?? attrs.model);
      push('provider', attrs['llm.provider'] ?? attrs.provider);
      push('input_tokens', attrs['llm.token_count.prompt'] ?? attrs.input_tokens);
      push('output_tokens', attrs['llm.token_count.completion'] ?? attrs.output_tokens);
      push('total_tokens', attrs['llm.token_count.total'] ?? attrs.total_tokens);
      if (attrs['llm.token_count.prompt_cache_hit']) push('cache_hit', attrs['llm.token_count.prompt_cache_hit']);
      if (flagRaw) {
        const prompt = (attrs['input.value'] ?? attrs.prompt) as string | undefined;
        const completion = (attrs['output.value'] ?? attrs.completion) as string | undefined;
        if (prompt) {
          lines.push(`    ${C.dim}prompt:${C.reset}`);
          for (const line of String(prompt).split('\n').slice(0, 30)) lines.push(`      ${line}`);
        }
        if (completion) {
          lines.push(`    ${C.dim}completion:${C.reset}`);
          for (const line of String(completion).split('\n').slice(0, 30)) lines.push(`      ${line}`);
        }
      } else {
        const prompt = (attrs['input.value'] ?? attrs.prompt) as string | undefined;
        const completion = (attrs['output.value'] ?? attrs.completion) as string | undefined;
        if (prompt) push('prompt[head]', String(prompt).slice(0, 120) + (String(prompt).length > 120 ? '…' : ''));
        if (completion)
          push('completion[head]', String(completion).slice(0, 120) + (String(completion).length > 120 ? '…' : ''));
      }
      if (attrs.error_message) push('error', attrs.error_message);
      break;
    case 'tool-execution':
    case 'tool-exec':
      push('tool', attrs['tool.name'] ?? attrs.tool_name);
      push('args_summary', attrs.args_summary);
      push('exit_code', attrs.exit_code);
      if (attrs.error_message) push('error', attrs.error_message);
      break;
    case 'a2a-hop':
      push('from', attrs.from_agent);
      push('to', attrs.to_agent);
      push('message_id', attrs.message_id ?? attrs.a2a_msg_id);
      push('origin_user', attrs.origin_user_id);
      push('content_preview', attrs.content_preview);
      break;
    case 'channel-deliver':
      push('channel', attrs.channel ?? attrs.platform);
      push('platform_msg_id', attrs.platform_msg_id);
      push('write_to_deliver_ms', attrs.write_to_deliver_ms);
      push('content_preview', attrs.content_preview);
      break;
    case 'container-lifecycle':
      push('event', attrs.event);
      push('outcome', attrs.outcome);
      push('container_name', attrs.container_name);
      break;
    default:
      for (const [k, v] of Object.entries(attrs)) push(k, v);
  }
  return lines;
}

// ─── header ─────────────────────────────────────────────────────────────────
const t0 = spans[0].start_ts;
const tEnd = Math.max(...spans.map((s) => s.end_ts ?? s.start_ts));
const agents = [...new Set(spans.map((s) => s.agent_group_id).filter(Boolean))];
const sessions = [...new Set(spans.map((s) => s.session_id).filter(Boolean))];
const llmSpans = spans.filter((s) => s.kind === 'llm-generation' || s.kind === 'llm-call');
const toolSpans = spans.filter((s) => s.kind === 'tool-execution' || s.kind === 'tool-exec');

let totalIn = 0,
  totalOut = 0;
for (const s of llmSpans) {
  const a = parseAttrs(s.attributes);
  totalIn += Number(a['llm.token_count.prompt'] ?? a.input_tokens ?? 0);
  totalOut += Number(a['llm.token_count.completion'] ?? a.output_tokens ?? 0);
}

const erroredSpans = spans.filter((s) => s.status === 'error').length;
const abandonedSpans = spans.filter((s) => s.status === 'abandoned').length;

console.log(`${C.bold}━━━ Trace ${traceId} ━━━${C.reset}`);
console.log();
console.log(`  ${C.dim}Started${C.reset}     ${new Date(t0).toISOString()}  (${fmtTime(t0)} local)`);
console.log(`  ${C.dim}Duration${C.reset}    ${((tEnd - t0) / 1000).toFixed(2)}s`);
console.log(`  ${C.dim}Spans${C.reset}       ${spans.length} total (${llmSpans.length} LLM, ${toolSpans.length} tool)`);
console.log(`  ${C.dim}Tokens${C.reset}      ${totalIn.toLocaleString()} in / ${totalOut.toLocaleString()} out`);
console.log(`  ${C.dim}Agents${C.reset}      ${agents.join(', ') || '(none)'}`);
console.log(`  ${C.dim}Sessions${C.reset}    ${sessions.join(', ') || '(none)'}`);
if (erroredSpans || abandonedSpans) {
  const parts: string[] = [];
  if (erroredSpans) parts.push(`${C.red}${erroredSpans} error${C.reset}`);
  if (abandonedSpans) parts.push(`${C.yellow}${abandonedSpans} abandoned${C.reset}`);
  console.log(`  ${C.dim}Issues${C.reset}      ${parts.join(', ')}`);
}
console.log();

// ─── timeline ───────────────────────────────────────────────────────────────
console.log(`${C.bold}Timeline${C.reset}`);
console.log();

for (const s of spans) {
  const attrs = parseAttrs(s.attributes);
  const t = fmtTime(s.start_ts);
  const offsetMs = s.start_ts - t0;
  const offset = offsetMs === 0 ? '+0.000s' : `+${(offsetMs / 1000).toFixed(3)}s`;
  const dur = fmtDur(s.start_ts, s.end_ts);
  const indent = s.parent_span_id ? '  └─ ' : '── ';
  console.log(
    `${C.dim}${t}${C.reset} ${C.dim}${offset.padEnd(8)}${C.reset} ${indent}${fmtKind(s.kind)} ${s.name}  ${C.dim}(${dur})${C.reset}  ${fmtStatus(s.status)}`,
  );
  const detailLines = summarizeAttrs(s.kind, attrs);
  for (const line of detailLines) console.log(line);
  if (detailLines.length > 0) console.log();
}

console.log(`${C.dim}━━━ End of trace ━━━${C.reset}`);

db.close();
