import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { fetchTrace } from '../lib/api';
import { spansForTrace, useSseStore } from '../lib/sse';
import type { SpanRecord } from '../lib/types';

const KIND_COLORS: Record<string, string> = {
  'channel-inbound': '#4a9eff',
  'agent-turn': '#a78bfa',
  'llm-call': '#34d399',
  'tool-exec': '#fbbf24',
  'a2a-hop': '#f472b6',
  'channel-deliver': '#60a5fa',
  'container-lifecycle': '#8a8f98',
};

export function TraceDetail() {
  const { id } = useParams<{ id: string }>();
  const [serverSpans, setServerSpans] = useState<SpanRecord[]>([]);
  const [selected, setSelected] = useState<SpanRecord | null>(null);
  const liveSpans = useSseStore((s) => s.spans);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchTrace(id)
      .then((data) => {
        if (!cancelled) setServerSpans(data);
      })
      .catch((err) => console.error('fetchTrace failed', err));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const spans = useMemo(() => {
    if (!id) return [];
    const merged = new Map<string, SpanRecord>();
    for (const s of serverSpans) merged.set(s.span_id, s);
    for (const s of spansForTrace(id)) merged.set(s.span_id, s); // SSE overrides
    return [...merged.values()].sort((a, b) => a.start_ts - b.start_ts);
  }, [serverSpans, liveSpans, id]);

  if (!id) return <div className="empty">No trace id</div>;
  if (spans.length === 0) return <div className="empty">No spans for {id}</div>;

  const t0 = spans[0].start_ts;
  const tMax = spans.reduce((m, s) => Math.max(m, s.end_ts ?? Date.now()), t0);
  const width = Math.max(1, tMax - t0);

  return (
    <div>
      <p>
        <Link to="/">← back</Link> &nbsp;{' '}
        <code>{id}</code>
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '1rem' }}>
        <div>
          <table>
            <thead>
              <tr>
                <th>Span</th>
                <th>Kind</th>
                <th>Timeline ({((tMax - t0) / 1000).toFixed(2)}s)</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {spans.map((s) => {
                const x = ((s.start_ts - t0) / width) * 100;
                const end = s.end_ts ?? Date.now();
                const w = Math.max(0.5, ((end - s.start_ts) / width) * 100);
                const color = KIND_COLORS[s.kind] ?? 'var(--accent)';
                return (
                  <tr
                    key={s.span_id}
                    onClick={() => setSelected(s)}
                    style={{ cursor: 'pointer' }}
                    className={s === selected ? 'active' : ''}
                  >
                    <td>{s.name}</td>
                    <td>{s.kind}</td>
                    <td>
                      <div style={{ position: 'relative', height: '14px', background: 'var(--row)', borderRadius: 2 }}>
                        <div
                          style={{
                            position: 'absolute',
                            left: `${x}%`,
                            width: `${w}%`,
                            top: 0,
                            bottom: 0,
                            background: color,
                            borderRadius: 2,
                            opacity: s.end_ts == null ? 0.55 : 1,
                          }}
                          title={`${((end - s.start_ts) / 1000).toFixed(3)}s`}
                        />
                      </div>
                    </td>
                    <td>
                      <span className={`status-pill ${s.status ?? 'ok'}`}>{s.status ?? 'ok'}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <aside style={{ border: '1px solid var(--border)', padding: '0.75rem', borderRadius: 6, overflow: 'auto' }}>
          {selected ? (
            <>
              <h3 style={{ marginTop: 0 }}>{selected.name}</h3>
              <p style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
                {selected.kind} · {((selected.end_ts ?? Date.now()) - selected.start_ts).toFixed(0)}ms
              </p>
              <table>
                <tbody>
                  {Object.entries(selected.attributes).map(([k, v]) => (
                    <tr key={k}>
                      <td style={{ verticalAlign: 'top', color: 'var(--muted)' }}>{k}</td>
                      <td>
                        <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.75rem' }}>
                          {typeof v === 'string' ? v : JSON.stringify(v, null, 2)}
                        </pre>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <div className="empty">Click a span to inspect</div>
          )}
        </aside>
      </div>
    </div>
  );
}
