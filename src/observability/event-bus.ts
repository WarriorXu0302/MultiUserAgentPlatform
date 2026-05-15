/**
 * Trace event bus — single in-process fan-out point for nano-monitor.
 *
 * Producers:
 *   - host-side spans (channel-inbound, a2a-hop, channel-deliver,
 *     container-lifecycle) emit directly via `traceEventBus.emitSpan(...)`.
 *   - container-side spans (agent-turn, llm-call, tool-exec) land in the
 *     per-session `outbound.db.trace_spans` table; the watcher in
 *     ./container-watcher.ts polls and forwards them through this bus.
 *
 * Consumers:
 *   - the persistor (`persist()` below) writes every emitted span to the
 *     central `v2.db.trace_events` table. ON CONFLICT(trace_id, span_id)
 *     does an upsert so a span-start followed by a span-end both land
 *     cleanly on the same row.
 *   - SSE clients subscribe via `subscribe()` and receive the in-memory
 *     SpanRecord directly (no DB round-trip).
 */
import { EventEmitter } from 'node:events';
import type Database from 'better-sqlite3';

import { getDb } from '../db/connection.js';
import { log } from '../log.js';

export type SpanKind =
  | 'channel-inbound'
  | 'agent-turn'
  | 'llm-call'
  | 'llm-generation'
  | 'tool-exec'
  | 'tool-execution'
  | 'a2a-hop'
  | 'channel-deliver'
  | 'container-lifecycle';

export type SpanStatus = 'in_flight' | 'ok' | 'error' | 'abandoned';

export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_ts: number;
  end_ts: number | null;
  status: SpanStatus | null;
  agent_group_id: string | null;
  session_id: string | null;
  attributes: Record<string, unknown>;
}

class TraceEventBus extends EventEmitter {
  private insertStmt: Database.Statement | null = null;

  emitSpan(span: SpanRecord): void {
    try {
      this.persist(span);
    } catch (err) {
      log.warn('trace event persist failed', {
        err,
        trace_id: span.trace_id,
        span_id: span.span_id,
      });
    }
    this.emit('span', span);
  }

  private persist(span: SpanRecord): void {
    if (!this.insertStmt) {
      this.insertStmt = getDb().prepare(`
        INSERT INTO trace_events
          (trace_id, span_id, parent_span_id, name, kind, start_ts, end_ts, status, agent_group_id, session_id, attributes)
        VALUES
          (@trace_id, @span_id, @parent_span_id, @name, @kind, @start_ts, @end_ts, @status, @agent_group_id, @session_id, @attributes)
        ON CONFLICT(trace_id, span_id) DO UPDATE SET
          end_ts = excluded.end_ts,
          status = excluded.status,
          attributes = excluded.attributes
      `);
    }
    this.insertStmt.run({
      trace_id: span.trace_id,
      span_id: span.span_id,
      parent_span_id: span.parent_span_id ?? null,
      name: span.name,
      kind: span.kind,
      start_ts: span.start_ts,
      end_ts: span.end_ts ?? null,
      status: span.status ?? (span.end_ts == null ? 'in_flight' : 'ok'),
      agent_group_id: span.agent_group_id ?? null,
      session_id: span.session_id ?? null,
      attributes: JSON.stringify(span.attributes ?? {}),
    });
  }

  subscribe(handler: (span: SpanRecord) => void): () => void {
    this.on('span', handler);
    return () => this.off('span', handler);
  }
}

export const traceEventBus = new TraceEventBus();

/**
 * Sweep in-flight spans older than the cutoff and mark them abandoned. Run
 * at host startup so spans from a crashed previous process don't stay open
 * forever in the UI.
 *
 * Excludes kind='container-lifecycle' — those legitimately stay in-flight
 * as long as the container is running (could be hours of legitimate idle
 * uptime).
 */
export function reapAbandonedSpans(olderThanMs = 60 * 60 * 1000): number {
  const cutoff = Date.now() - olderThanMs;
  const res = getDb()
    .prepare(
      `UPDATE trace_events
         SET end_ts = start_ts, status = 'abandoned'
         WHERE end_ts IS NULL
           AND start_ts < ?
           AND kind != 'container-lifecycle'`,
    )
    .run(cutoff);
  if (res.changes > 0) {
    log.info('Reaped abandoned trace spans', { count: res.changes });
  }
  return res.changes;
}

/**
 * Continuous stale-trace reaper. Any non-lifecycle span that's been
 * in-flight for >{idleMs} (default 60s) gets marked abandoned. This is
 * what stops "live" indicator from getting stuck for hours when a span's
 * end emit goes missing (e.g. container crash mid-turn).
 *
 * Idempotent — safe to call on a timer.
 */
export function reapStaleSpans(idleMs = 60_000): number {
  const cutoff = Date.now() - idleMs;
  const res = getDb()
    .prepare(
      `UPDATE trace_events
         SET end_ts = start_ts, status = 'abandoned'
         WHERE end_ts IS NULL
           AND start_ts < ?
           AND kind != 'container-lifecycle'`,
    )
    .run(cutoff);
  return res.changes;
}

let staleReaperTimer: NodeJS.Timeout | null = null;
export function startStaleSpanReaper(intervalMs = 30_000): void {
  if (staleReaperTimer) return;
  staleReaperTimer = setInterval(() => {
    try {
      const n = reapStaleSpans();
      if (n > 0) log.info('Stale span reaper closed in-flight spans', { count: n });
    } catch (err) {
      log.warn('Stale span reaper tick failed', { err });
    }
  }, intervalMs);
  log.info('Stale span reaper started', { intervalMs });
}

export function stopStaleSpanReaper(): void {
  if (!staleReaperTimer) return;
  clearInterval(staleReaperTimer);
  staleReaperTimer = null;
}
