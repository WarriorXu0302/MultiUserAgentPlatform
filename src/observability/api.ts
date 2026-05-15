/**
 * REST + SSE endpoints for nano-monitor.
 *
 * Mounted on the shared webhook-server (port 3000 by default). Paths are
 * exact-match — query parameters carry trace ids, since the server's router
 * doesn't do pattern routes. CORS is permissive in dev (Vite frontend on
 * :3001); tighten via FRONTLANE_MONITOR_CORS_ORIGIN in prod.
 *
 * Endpoints:
 *   GET  /api/traces?limit=50&since=<ms>     — recent traces (rollup)
 *   GET  /api/trace?id=<trace_id>            — all spans for one trace
 *   GET  /api/containers                     — currently running containers
 *   GET  /api/topology?windowMin=10          — a2a edges aggregate
 *   GET  /events/stream                      — Server-Sent Events: live spans
 */
import http from 'node:http';

import { getDb } from '../db/connection.js';
import { log } from '../log.js';
import { registerWebhookHandler } from '../webhook-server.js';

import { traceEventBus, type SpanRecord } from './event-bus.js';

const CORS_ORIGIN = process.env.FRONTLANE_MONITOR_CORS_ORIGIN ?? '*';

interface TraceEventRow {
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

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload).toString(),
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function parseQuery(req: http.IncomingMessage): URLSearchParams {
  const host = req.headers.host ?? 'localhost';
  return new URL(req.url ?? '/', `http://${host}`).searchParams;
}

function rowToSpan(row: TraceEventRow): SpanRecord {
  let attrs: Record<string, unknown> = {};
  try {
    attrs = JSON.parse(row.attributes) as Record<string, unknown>;
  } catch {
    /* malformed JSON — return empty */
  }
  return {
    trace_id: row.trace_id,
    span_id: row.span_id,
    parent_span_id: row.parent_span_id,
    name: row.name,
    kind: row.kind as SpanRecord['kind'],
    start_ts: row.start_ts,
    end_ts: row.end_ts,
    status: row.status as SpanRecord['status'] | null,
    agent_group_id: row.agent_group_id,
    session_id: row.session_id,
    attributes: attrs,
  };
}

function handleTracesList(req: http.IncomingMessage, res: http.ServerResponse): void {
  const q = parseQuery(req);
  const limit = Math.max(1, Math.min(500, Number(q.get('limit') ?? '50')));
  const since = Number(q.get('since') ?? '0');
  const includeLifecycle = q.get('lifecycle') === '1';

  // Container-lifecycle traces use trace_id 'session:...' and represent a
  // single container's run, not a user turn — filter them out of the main
  // trace list (they live in /api/containers). Set ?lifecycle=1 to include.
  const lifecycleFilter = includeLifecycle ? '' : "AND trace_id NOT LIKE 'session:%'";

  const rows = getDb()
    .prepare(
      `SELECT
         trace_id,
         MIN(start_ts) AS start_ts,
         MAX(COALESCE(end_ts, start_ts)) AS last_ts,
         COUNT(*) AS span_count,
         SUM(CASE WHEN end_ts IS NULL THEN 1 ELSE 0 END) AS in_flight,
         MAX(agent_group_id) AS agent_group_id,
         MAX(session_id) AS session_id,
         SUM(CASE WHEN kind = 'llm-generation' OR kind = 'llm-call' THEN 1 ELSE 0 END) AS llm_calls,
         SUM(CASE WHEN kind = 'tool-execution' OR kind = 'tool-exec' THEN 1 ELSE 0 END) AS tool_calls,
         SUM(CAST(json_extract(attributes, '$.input_tokens') AS INTEGER)) AS input_tokens,
         SUM(CAST(json_extract(attributes, '$.output_tokens') AS INTEGER)) AS output_tokens
       FROM trace_events
       WHERE start_ts > ? ${lifecycleFilter}
       GROUP BY trace_id
       ORDER BY start_ts DESC
       LIMIT ?`,
    )
    .all(since, limit) as Array<{
    trace_id: string;
    start_ts: number;
    last_ts: number;
    span_count: number;
    in_flight: number;
    agent_group_id: string | null;
    session_id: string | null;
    llm_calls: number;
    tool_calls: number;
    input_tokens: number | null;
    output_tokens: number | null;
  }>;

  writeJson(res, 200, {
    traces: rows.map((r) => ({
      trace_id: r.trace_id,
      start_ts: r.start_ts,
      last_ts: r.last_ts,
      duration_ms: r.last_ts - r.start_ts,
      span_count: r.span_count,
      active: r.in_flight > 0,
      agent_group_id: r.agent_group_id,
      session_id: r.session_id,
      llm_calls: r.llm_calls,
      tool_calls: r.tool_calls,
      input_tokens: r.input_tokens ?? 0,
      output_tokens: r.output_tokens ?? 0,
    })),
  });
}

function handleTraceDetail(req: http.IncomingMessage, res: http.ServerResponse): void {
  const q = parseQuery(req);
  const traceId = q.get('id');
  if (!traceId) {
    writeJson(res, 400, { error: "missing 'id' query parameter" });
    return;
  }
  const rows = getDb()
    .prepare('SELECT * FROM trace_events WHERE trace_id = ? ORDER BY start_ts, span_id')
    .all(traceId) as TraceEventRow[];
  writeJson(res, 200, { trace_id: traceId, spans: rows.map(rowToSpan) });
}

function handleContainers(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const rows = getDb()
    .prepare(
      `SELECT
         id            AS session_id,
         agent_group_id,
         container_status,
         last_active,
         status
       FROM sessions
       WHERE status = 'active'
       ORDER BY last_active DESC`,
    )
    .all() as Array<{
    session_id: string;
    agent_group_id: string;
    container_status: string | null;
    last_active: string | null;
    status: string;
  }>;
  writeJson(res, 200, { containers: rows });
}

function handleTopology(req: http.IncomingMessage, res: http.ServerResponse): void {
  const q = parseQuery(req);
  const windowMin = Math.max(1, Math.min(1440, Number(q.get('windowMin') ?? '60')));
  const since = Date.now() - windowMin * 60_000;

  // a2a-hop spans carry from_agent/to_agent in attributes JSON; we aggregate
  // in JS rather than SQL because SQLite's json_extract gets verbose here
  // and the row count is small (a2a-hop is one-per-delegation).
  const rows = getDb()
    .prepare(
      `SELECT attributes, start_ts, end_ts FROM trace_events
         WHERE kind = 'a2a-hop' AND start_ts > ?
         ORDER BY start_ts DESC LIMIT 5000`,
    )
    .all(since) as Array<{ attributes: string; start_ts: number; end_ts: number | null }>;

  const edges = new Map<string, { from: string; to: string; count: number; latency_sum: number }>();
  const nodes = new Set<string>();
  for (const r of rows) {
    let attrs: Record<string, unknown>;
    try {
      attrs = JSON.parse(r.attributes) as Record<string, unknown>;
    } catch {
      continue;
    }
    const from = String(attrs.from_agent ?? '');
    const to = String(attrs.to_agent ?? '');
    if (!from || !to) continue;
    nodes.add(from);
    nodes.add(to);
    const key = `${from}→${to}`;
    const existing = edges.get(key) ?? { from, to, count: 0, latency_sum: 0 };
    existing.count += 1;
    if (r.end_ts != null) existing.latency_sum += r.end_ts - r.start_ts;
    edges.set(key, existing);
  }

  writeJson(res, 200, {
    nodes: [...nodes].map((id) => ({ id })),
    edges: [...edges.values()].map((e) => ({
      from: e.from,
      to: e.to,
      count: e.count,
      avg_latency_ms: e.count > 0 ? Math.round(e.latency_sum / e.count) : null,
    })),
    windowMin,
  });
}

function handleEventsStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'X-Accel-Buffering': 'no',
  });
  // Initial comment to flush headers immediately on some clients
  res.write(': connected\n\n');

  const send = (span: SpanRecord): void => {
    try {
      res.write(`event: span\ndata: ${JSON.stringify(span)}\n\n`);
    } catch (err) {
      log.debug('SSE write failed', { err });
    }
  };
  const unsubscribe = traceEventBus.subscribe(send);

  // Heartbeat keeps the connection alive through idle network paths and
  // signals the client we're still here.
  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      cleanup();
    }
  }, 15_000);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    try {
      res.end();
    } catch {
      /* already closed */
    }
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
}

function handleCorsPreflight(_req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(204, {
    'Access-Control-Allow-Origin': CORS_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  });
  res.end();
}

function wrapWithMethodGuard(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return (req, res) => {
    if (req.method === 'OPTIONS') {
      handleCorsPreflight(req, res);
      return;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Access-Control-Allow-Origin': CORS_ORIGIN });
      res.end('Method Not Allowed');
      return;
    }
    try {
      handler(req, res);
    } catch (err) {
      log.error('monitor api handler failed', { url: req.url, err });
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal_error' });
      } else if (!res.writableEnded) {
        res.end();
      }
    }
  };
}

export function registerMonitorEndpoints(): void {
  registerWebhookHandler('/api/traces', wrapWithMethodGuard(handleTracesList));
  registerWebhookHandler('/api/trace', wrapWithMethodGuard(handleTraceDetail));
  registerWebhookHandler('/api/containers', wrapWithMethodGuard(handleContainers));
  registerWebhookHandler('/api/topology', wrapWithMethodGuard(handleTopology));
  registerWebhookHandler('/events/stream', wrapWithMethodGuard(handleEventsStream));
  log.info('nano-monitor endpoints registered', {
    paths: ['/api/traces', '/api/trace', '/api/containers', '/api/topology', '/events/stream'],
  });
}
