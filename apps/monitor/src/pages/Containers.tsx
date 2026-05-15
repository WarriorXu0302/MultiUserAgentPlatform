import { useEffect, useState } from 'react';

import { fetchContainers } from '../lib/api';
import type { ContainerEntry } from '../lib/types';

export function Containers() {
  const [containers, setContainers] = useState<ContainerEntry[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await fetchContainers();
        if (!cancelled) setContainers(data);
      } catch (err) {
        console.error('fetchContainers failed', err);
      }
    };
    load();
    const t = setInterval(load, 1_500);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  if (containers.length === 0) {
    return <div className="empty">No active sessions.</div>;
  }

  return (
    <table>
      <thead>
        <tr>
          <th>Session</th>
          <th>Agent group</th>
          <th>Container</th>
          <th>Last active</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        {containers.map((c) => (
          <tr key={c.session_id}>
            <td>{c.session_id.slice(-10)}</td>
            <td>{c.agent_group_id}</td>
            <td>{c.container_status ?? '—'}</td>
            <td>{c.last_active ?? '—'}</td>
            <td>
              <span className={`status-pill ${c.container_status === 'running' ? 'in_flight' : 'ok'}`}>
                {c.status}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
