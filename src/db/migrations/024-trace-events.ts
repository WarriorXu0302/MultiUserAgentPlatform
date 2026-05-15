import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Persistent span store for the in-host nano-monitor. event-bus.ts inserts
 * every emitted span here so the UI / sidecar can render the trace tree
 * even after the originating process has exited.
 *
 * Background: nano-monitor code landed in delivery.ts / router.ts /
 * container-runner.ts before its companion schema migration shipped, so any
 * host build past that point was warning-spamming `no such table: trace_events`
 * on every span emit — and worse, the span emit at container teardown was
 * throwing inside the exit-handler path, leaving the child process exit
 * code at 1. That made every successful frontdesk turn look like a "crash"
 * in host logs. This table fixes both.
 *
 * Column shape mirrors the INSERT in event-bus.ts:69-77. `attributes` is
 * the JSON-serialized free-form span attribute map; nullable to keep the
 * insert path flexible for upstream code that omits it.
 */
export const migration024: Migration = {
  version: 24,
  name: 'trace-events',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS trace_events (
        trace_id        TEXT NOT NULL,
        span_id         TEXT NOT NULL,
        parent_span_id  TEXT,
        name            TEXT NOT NULL,
        kind            TEXT NOT NULL,
        start_ts        INTEGER NOT NULL,
        end_ts          INTEGER,
        status          TEXT,
        agent_group_id  TEXT,
        session_id      TEXT,
        attributes      TEXT,
        PRIMARY KEY (trace_id, span_id)
      );
      CREATE INDEX IF NOT EXISTS idx_trace_events_trace ON trace_events(trace_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_session ON trace_events(session_id);
      CREATE INDEX IF NOT EXISTS idx_trace_events_start ON trace_events(start_ts);
    `);
  },
};
