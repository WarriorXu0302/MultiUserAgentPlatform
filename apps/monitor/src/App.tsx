import { useEffect } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';

import { startSse, stopSse, useSseStore } from './lib/sse';
import { Containers } from './pages/Containers';
import { Tokens } from './pages/Tokens';
import { Topology } from './pages/Topology';
import { TraceDetail } from './pages/TraceDetail';
import { TraceList } from './pages/TraceList';

export function App() {
  const connected = useSseStore((s) => s.connected);

  useEffect(() => {
    startSse();
    return () => stopSse();
  }, []);

  return (
    <div className="app-shell">
      <nav className="app-nav">
        <strong>FrontLane Monitor</strong>
        <NavLink to="/" end>
          Traces
        </NavLink>
        <NavLink to="/topology">Topology</NavLink>
        <NavLink to="/containers">Containers</NavLink>
        <NavLink to="/tokens">Tokens</NavLink>
        <span style={{ marginLeft: 'auto', color: connected ? 'var(--ok)' : 'var(--muted)' }}>
          {connected ? '● live' : '○ disconnected'}
        </span>
      </nav>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<TraceList />} />
          <Route path="/trace/:id" element={<TraceDetail />} />
          <Route path="/topology" element={<Topology />} />
          <Route path="/containers" element={<Containers />} />
          <Route path="/tokens" element={<Tokens />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
