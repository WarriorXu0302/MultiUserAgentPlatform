import { useEffect, useState } from 'react';

import { fetchTopology } from '../lib/api';
import type { TopologyResponse } from '../lib/types';

export function Topology() {
  const [data, setData] = useState<TopologyResponse | null>(null);
  const [windowMin, setWindowMin] = useState(60);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchTopology(windowMin);
        if (!cancelled) setData(next);
      } catch (err) {
        console.error('fetchTopology failed', err);
      }
    };
    load();
    const t = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [windowMin]);

  return (
    <div>
      <div style={{ marginBottom: '1rem' }}>
        Window:{' '}
        {[10, 60, 360, 1440].map((m) => (
          <button
            key={m}
            onClick={() => setWindowMin(m)}
            style={{
              marginRight: 6,
              padding: '0.25rem 0.5rem',
              background: m === windowMin ? 'var(--accent)' : 'var(--row)',
              color: 'var(--fg)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              cursor: 'pointer',
            }}
          >
            {m < 60 ? `${m}m` : `${m / 60}h`}
          </button>
        ))}
      </div>

      {!data ? (
        <div className="empty">Loading…</div>
      ) : data.edges.length === 0 ? (
        <div className="empty">No a2a activity in the last {windowMin}min.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>From</th>
              <th>→</th>
              <th>To</th>
              <th>Hops</th>
              <th>Avg latency</th>
            </tr>
          </thead>
          <tbody>
            {data.edges.map((e) => (
              <tr key={`${e.from}-${e.to}`}>
                <td>{e.from}</td>
                <td>→</td>
                <td>{e.to}</td>
                <td>{e.count}</td>
                <td>{e.avg_latency_ms != null ? `${e.avg_latency_ms}ms` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
