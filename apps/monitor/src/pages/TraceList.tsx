import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { fetchTraces } from '../lib/api';
import { useSseStore } from '../lib/sse';
import type { TraceListEntry } from '../lib/types';

export function TraceList() {
  const [traces, setTraces] = useState<TraceListEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const liveBumps = useSseStore((s) => s.traceTimestamps);
  const recentSpanRxTs = useSseStore((s) => s.recentSpanRxTs);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchTraces({ limit: 50 });
        if (!cancelled) setTraces(data);
      } catch (err) {
        console.error('fetchTraces failed', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const tick = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, []);

  // Merge live-ingested traces (from SSE) that may not yet be in the
  // server-rendered list. Server data wins on duration/count, live tells us
  // a new trace started.
  const merged = [...traces];
  const known = new Set(traces.map((t) => t.trace_id));
  for (const [traceId, info] of liveBumps.entries()) {
    if (known.has(traceId)) continue;
    merged.unshift({
      trace_id: traceId,
      start_ts: info.first_ts,
      last_ts: info.last_ts,
      duration_ms: info.last_ts - info.first_ts,
      span_count: info.span_count,
      active: info.active,
      agent_group_id: null,
      session_id: null,
      llm_calls: 0,
      tool_calls: 0,
      input_tokens: 0,
      output_tokens: 0,
    });
  }
  merged.sort((a, b) => b.start_ts - a.start_ts);

  return (
    <div>
      <div className="kpi-bar">
        <div className="kpi">
          <div className="kpi-label">Traces shown</div>
          <div className="kpi-value">{merged.length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Live (in-flight)</div>
          <div className="kpi-value">{merged.filter((t) => t.active).length}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Live spans (SSE, 60s)</div>
          <div className="kpi-value">{recentSpanRxTs.length}</div>
        </div>
      </div>

      {loading && traces.length === 0 ? (
        <div className="empty">Loading…</div>
      ) : merged.length === 0 ? (
        <div className="empty">No traces yet. Send a message to a wired channel.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Trace</th>
              <th>Started</th>
              <th>Duration</th>
              <th>Spans</th>
              <th>LLM</th>
              <th>Tools</th>
              <th>Tokens (in/out)</th>
              <th>Status</th>
              <th>Agent</th>
            </tr>
          </thead>
          <tbody>
            {merged.map((t) => (
              <tr key={t.trace_id} className={t.active ? 'active' : ''}>
                <td>
                  <Link to={`/trace/${t.trace_id}`}>{t.trace_id.slice(0, 8)}…</Link>
                </td>
                <td>{new Date(t.start_ts).toLocaleTimeString()}</td>
                <td>{(t.duration_ms / 1000).toFixed(2)}s</td>
                <td>{t.span_count}</td>
                <td>{t.llm_calls}</td>
                <td>{t.tool_calls}</td>
                <td>
                  {t.input_tokens.toLocaleString()} / {t.output_tokens.toLocaleString()}
                </td>
                <td>
                  <span className={`status-pill ${t.active ? 'in_flight' : 'ok'}`}>
                    {t.active ? 'live' : 'done'}
                  </span>
                </td>
                <td>{t.agent_group_id ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
