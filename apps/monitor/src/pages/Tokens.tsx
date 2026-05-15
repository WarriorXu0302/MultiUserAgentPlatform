import { useMemo } from 'react';

import { useSseStore } from '../lib/sse';

interface ModelStat {
  model: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  total_duration_ms: number;
}

export function Tokens() {
  const spans = useSseStore((s) => s.spans);

  const stats = useMemo(() => {
    const byModel = new Map<string, ModelStat>();
    for (const s of spans.values()) {
      if (s.kind !== 'llm-call') continue;
      const a = s.attributes;
      const model = String(a.model ?? 'unknown');
      const entry = byModel.get(model) ?? {
        model,
        calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        total_duration_ms: 0,
      };
      entry.calls += 1;
      entry.input_tokens += Number(a.input_tokens ?? 0);
      entry.output_tokens += Number(a.output_tokens ?? 0);
      const dur = s.end_ts != null ? s.end_ts - s.start_ts : 0;
      entry.total_duration_ms += dur;
      byModel.set(model, entry);
    }
    return [...byModel.values()].sort((a, b) => b.input_tokens - a.input_tokens);
  }, [spans]);

  const totalInput = stats.reduce((s, m) => s + m.input_tokens, 0);
  const totalOutput = stats.reduce((s, m) => s + m.output_tokens, 0);
  const totalCalls = stats.reduce((s, m) => s + m.calls, 0);

  return (
    <div>
      <div className="kpi-bar">
        <div className="kpi">
          <div className="kpi-label">LLM calls (live)</div>
          <div className="kpi-value">{totalCalls}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Input tokens</div>
          <div className="kpi-value">{totalInput.toLocaleString()}</div>
        </div>
        <div className="kpi">
          <div className="kpi-label">Output tokens</div>
          <div className="kpi-value">{totalOutput.toLocaleString()}</div>
        </div>
      </div>

      {stats.length === 0 ? (
        <div className="empty">No LLM calls observed yet (live window only — restart host or wait).</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Model</th>
              <th>Calls</th>
              <th>Input tok</th>
              <th>Output tok</th>
              <th>Avg latency</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((m) => (
              <tr key={m.model}>
                <td>{m.model}</td>
                <td>{m.calls}</td>
                <td>{m.input_tokens.toLocaleString()}</td>
                <td>{m.output_tokens.toLocaleString()}</td>
                <td>{m.calls > 0 ? `${Math.round(m.total_duration_ms / m.calls)}ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p style={{ color: 'var(--muted)', fontSize: '0.75rem', marginTop: '1rem' }}>
        Note: live-only aggregation across the SSE buffer. For historical aggregates we'll need a dedicated
        backend endpoint (TODO Phase 5).
      </p>
    </div>
  );
}
