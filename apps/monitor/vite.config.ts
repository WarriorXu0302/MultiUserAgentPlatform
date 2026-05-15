import fs from 'node:fs';
import path from 'node:path';

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Read WEBHOOK_PORT from the host's root .env so the Vite proxy lands on
// the actual port the host listens on (we've seen real deployments use
// 13000, not the 3000 default). Override path:
//   FRONTLANE_MONITOR_BACKEND_PORT > root .env WEBHOOK_PORT > 3000
function readEnvPort(): number | undefined {
  try {
    const envPath = path.resolve(__dirname, '..', '..', '.env');
    if (!fs.existsSync(envPath)) return undefined;
    const text = fs.readFileSync(envPath, 'utf8');
    const m = text.match(/^WEBHOOK_PORT\s*=\s*(\d+)\s*$/m);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

const BACKEND_PORT = Number(
  process.env.FRONTLANE_MONITOR_BACKEND_PORT ?? readEnvPort() ?? '3000',
);
const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.FRONTLANE_MONITOR_PORT ?? '3001'),
    strictPort: true,
    // Bind on all interfaces so 127.0.0.1 (IPv4) works in addition to
    // localhost (IPv6). Useful when the user's HTTP proxy doesn't bypass
    // localhost — 127.0.0.1 is typically excluded by default.
    host: '0.0.0.0',
    proxy: {
      '/api': { target: BACKEND_URL, changeOrigin: false },
      '/events': { target: BACKEND_URL, changeOrigin: false, ws: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
