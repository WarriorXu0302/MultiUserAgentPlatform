/**
 * Watches each active session's `outbound.db.trace_spans` table and forwards
 * new rows to the trace event bus. This is the bridge between the
 * container-written span buffer (per-session DB) and the host-wide bus.
 *
 * Polling interval defaults to 200 ms — tunable via FRONTLANE_MONITOR_POLL_MS.
 * The watcher tracks a per-session `lastSeen` cursor in memory; on host
 * restart cursors reset to 0 and any rows the host hadn't drained yet are
 * re-emitted (upsert in the bus persistor makes this idempotent).
 *
 * Sessions whose outbound.db doesn't have the `trace_spans` table yet (older
 * session, container has never spawned since the schema rollout) are silently
 * skipped — the table gets created on next container spawn via the
 * forward-compat block in container/agent-runner/src/db/connection.ts.
 */
import { getActiveSessions } from '../db/sessions.js';
import { log } from '../log.js';
import { openOutboundDb } from '../session-manager.js';

import { traceEventBus, type SpanKind, type SpanRecord, type SpanStatus } from './event-bus.js';

interface TraceSpanRow {
  seq: number;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: string;
  start_ts: number;
  end_ts: number | null;
  status: string | null;
  attributes: string;
}

const POLL_INTERVAL_MS = Number(process.env.FRONTLANE_MONITOR_POLL_MS ?? '200');
const BATCH_LIMIT = 500;

const lastSeen = new Map<string, number>();
let timer: NodeJS.Timeout | null = null;

export function startContainerSpanWatcher(): void {
  if (timer) return;
  log.info('Starting container span watcher', { intervalMs: POLL_INTERVAL_MS });
  timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function stopContainerSpanWatcher(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

function tick(): void {
  let sessions;
  try {
    sessions = getActiveSessions();
  } catch (err) {
    log.warn('container watcher: failed to list active sessions', { err });
    return;
  }

  for (const s of sessions) {
    drainOne(s.id, s.agent_group_id);
  }
}

function drainOne(sessionId: string, agentGroupId: string): void {
  let db;
  try {
    db = openOutboundDb(agentGroupId, sessionId);
  } catch {
    // outbound.db missing (very fresh session) — try again next tick
    return;
  }

  try {
    const cursor = lastSeen.get(sessionId) ?? 0;
    let rows: TraceSpanRow[];
    try {
      rows = db
        .prepare('SELECT * FROM trace_spans WHERE seq > ? ORDER BY seq LIMIT ?')
        .all(cursor, BATCH_LIMIT) as TraceSpanRow[];
    } catch {
      // trace_spans table doesn't exist yet on this session — skip silently.
      // It'll appear after the next container spawn.
      return;
    }
    if (rows.length === 0) return;

    let maxSeq = cursor;
    for (const r of rows) {
      let attrs: Record<string, unknown> = {};
      try {
        attrs = JSON.parse(r.attributes) as Record<string, unknown>;
      } catch {
        // malformed JSON — keep empty attrs but still forward the span
      }
      const span: SpanRecord = {
        trace_id: r.trace_id,
        span_id: r.span_id,
        parent_span_id: r.parent_span_id,
        name: r.name,
        kind: r.kind as SpanKind,
        start_ts: r.start_ts,
        end_ts: r.end_ts,
        status: (r.status as SpanStatus | null) ?? (r.end_ts == null ? 'in_flight' : 'ok'),
        agent_group_id: agentGroupId,
        session_id: sessionId,
        attributes: attrs,
      };
      traceEventBus.emitSpan(span);
      if (r.seq > maxSeq) maxSeq = r.seq;
    }
    lastSeen.set(sessionId, maxSeq);
  } finally {
    try {
      db.close();
    } catch {
      // best-effort
    }
  }
}
