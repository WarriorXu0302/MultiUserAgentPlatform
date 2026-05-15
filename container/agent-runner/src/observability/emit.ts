/**
 * Container-side trace span emitter.
 *
 * Writes spans to `outbound.db.trace_spans`. Host watcher
 * (src/observability/container-watcher.ts) drains rows from here and forwards
 * them to the central trace event bus.
 *
 * Design notes:
 *   - All writes are best-effort: any DB error is swallowed (logged to
 *     stderr) so the LLM main path is never blocked by observability.
 *   - Prepared statements are cached lazily — span emit is high-frequency
 *     (tens per turn) and we want microsecond-class latency per call.
 *   - trace_id resolution is the caller's job: poll-loop passes it down via
 *     a context object derived from messages_in.trace_id.
 *   - span_id is 16 hex chars (8 random bytes), matching W3C traceparent's
 *     parent-id width so we can upgrade later without a schema change.
 */
import crypto from 'node:crypto';
import type { Statement } from 'bun:sqlite';

import { getOutboundDb } from '../db/connection.js';

export type SpanKind =
  | 'agent-turn'
  | 'llm-call'
  | 'llm-generation'
  | 'tool-exec'
  | 'tool-execution';
export type SpanStatus = 'in_flight' | 'ok' | 'error';

export interface SpanHandle {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_ts: number;
  attributes: Record<string, unknown>;
}

export interface StartSpanInput {
  trace_id: string;
  parent_span_id?: string | null;
  name: string;
  kind: SpanKind;
  attributes?: Record<string, unknown>;
}

export interface EndSpanInput {
  status?: SpanStatus;
  /** Merged onto the existing attributes (shallow). */
  attributesPatch?: Record<string, unknown>;
}

let insertStmt: Statement | null = null;
let updateStmt: Statement | null = null;

function getInsertStmt(): Statement {
  if (!insertStmt) {
    insertStmt = getOutboundDb().prepare(`
      INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, name, kind, start_ts, end_ts, status, attributes)
      VALUES
        ($trace_id, $span_id, $parent_span_id, $name, $kind, $start_ts, NULL, 'in_flight', $attributes)
    `);
  }
  return insertStmt;
}

function getUpdateStmt(): Statement {
  // endSpan is implemented as an INSERT, not an UPDATE — the host watcher
  // tracks new rows via the auto-incrementing `seq` column, so an UPDATE on
  // an existing row is invisible to the watcher (seq doesn't change). By
  // inserting a fresh row with the same (trace_id, span_id), the host's
  // ON CONFLICT upsert in event-bus.ts merges end_ts/status/attributes onto
  // the original span_id row in v2.db.trace_events. The per-session
  // outbound.db.trace_spans table ends up with two rows per span (start +
  // end) but it's just a staging buffer — nobody else reads it.
  if (!updateStmt) {
    updateStmt = getOutboundDb().prepare(`
      INSERT INTO trace_spans
        (trace_id, span_id, parent_span_id, name, kind, start_ts, end_ts, status, attributes)
      VALUES
        ($trace_id, $span_id, $parent_span_id, $name, $kind, $start_ts, $end_ts, $status, $attributes)
    `);
  }
  return updateStmt;
}

export function newSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function startSpan(input: StartSpanInput): SpanHandle {
  const span_id = newSpanId();
  const start_ts = Date.now();
  const attributes = input.attributes ?? {};
  const handle: SpanHandle = {
    trace_id: input.trace_id,
    span_id,
    parent_span_id: input.parent_span_id ?? null,
    name: input.name,
    kind: input.kind,
    start_ts,
    attributes,
  };
  try {
    getInsertStmt().run({
      $trace_id: handle.trace_id,
      $span_id: handle.span_id,
      $parent_span_id: handle.parent_span_id,
      $name: handle.name,
      $kind: handle.kind,
      $start_ts: handle.start_ts,
      $attributes: JSON.stringify(attributes),
    });
  } catch (err) {
    console.error('[trace-emit] startSpan failed:', (err as Error).message ?? err);
  }
  return handle;
}

export function endSpan(handle: SpanHandle, opts: EndSpanInput = {}): void {
  const end_ts = Date.now();
  const status = opts.status ?? 'ok';
  const attrs = opts.attributesPatch ? { ...handle.attributes, ...opts.attributesPatch } : handle.attributes;
  try {
    // Insert an "end" row carrying the same (trace_id, span_id) so the host
    // watcher picks it up via the new seq and upserts on top of the start
    // row in v2.db.trace_events.
    getUpdateStmt().run({
      $trace_id: handle.trace_id,
      $span_id: handle.span_id,
      $parent_span_id: handle.parent_span_id,
      $name: handle.name,
      $kind: handle.kind,
      $start_ts: handle.start_ts,
      $end_ts: end_ts,
      $status: status,
      $attributes: JSON.stringify(attrs),
    });
  } catch (err) {
    console.error('[trace-emit] endSpan failed:', (err as Error).message ?? err);
  }
}

/**
 * Convenience wrapper: run an async function inside a span. Always closes
 * the span (with status=error on throw). Returns the function's return value.
 */
export async function withSpan<T>(
  input: StartSpanInput,
  fn: (handle: SpanHandle) => Promise<T>,
): Promise<T> {
  const handle = startSpan(input);
  try {
    const result = await fn(handle);
    endSpan(handle, { status: 'ok' });
    return result;
  } catch (err) {
    endSpan(handle, {
      status: 'error',
      attributesPatch: { error_message: (err as Error)?.message ?? String(err) },
    });
    throw err;
  }
}

/**
 * Truncate large strings before stashing in span attributes (prompt /
 * completion can be 30KB+). Limit configurable via env so prod can tighten
 * for privacy/cost.
 */
const DEFAULT_LIMIT = Number(process.env.FRONTLANE_MONITOR_PROMPT_LIMIT ?? '32768');
export function truncate(value: string, limit = DEFAULT_LIMIT): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit) + `…[truncated ${value.length - limit}]`;
}

/**
 * Module-level "currently active" span. Mirrors the request-context module:
 * poll-loop pushes a span at turn start, providers/tools read it to anchor
 * their child spans, poll-loop clears on turn end. Bun's runtime is
 * single-threaded so this never races. Provider hooks (claude.ts hooks)
 * that fire inside the SDK still see it because the SDK invokes hooks
 * synchronously on the same Promise chain.
 */
let _currentSpan: SpanHandle | null = null;

export function setCurrentSpan(handle: SpanHandle | null): void {
  _currentSpan = handle;
}

export function getCurrentSpan(): SpanHandle | null {
  return _currentSpan;
}
