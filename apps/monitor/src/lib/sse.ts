import { create } from 'zustand';

import type { SpanRecord } from './types';

interface SseState {
  connected: boolean;
  /** Last-seen spans keyed by `${trace_id}:${span_id}`. Capped at 5000. */
  spans: Map<string, SpanRecord>;
  /** Span counts grouped by trace_id, for live trace-list updates. */
  traceTimestamps: Map<string, { first_ts: number; last_ts: number; span_count: number; active: boolean }>;
  /**
   * Wall-clock timestamps (ms) when each SSE span was received, used for
   * the "Live spans (SSE)" sliding-window counter. Pruned on every ingest:
   * anything older than {@link RECENT_WINDOW_MS} is dropped, so the array
   * length is always "spans received in the last N seconds".
   */
  recentSpanRxTs: number[];
  ingest: (span: SpanRecord) => void;
  setConnected: (v: boolean) => void;
  clear: () => void;
}

const MAX_SPANS = 5000;
const RECENT_WINDOW_MS = 60_000;

export const useSseStore = create<SseState>((set) => ({
  connected: false,
  spans: new Map(),
  traceTimestamps: new Map(),
  recentSpanRxTs: [],
  ingest: (span) =>
    set((state) => {
      const now = Date.now();
      const cutoff = now - RECENT_WINDOW_MS;
      // Drop expired Rx timestamps and append the new one.
      const recentSpanRxTs = state.recentSpanRxTs.filter((t) => t >= cutoff);
      recentSpanRxTs.push(now);
      const key = `${span.trace_id}:${span.span_id}`;
      const spans = new Map(state.spans);
      spans.set(key, span);
      if (spans.size > MAX_SPANS) {
        // Evict oldest entries (insertion order)
        const overflow = spans.size - MAX_SPANS;
        const it = spans.keys();
        for (let i = 0; i < overflow; i++) {
          const next = it.next();
          if (next.done) break;
          spans.delete(next.value);
        }
      }
      const traceTimestamps = new Map(state.traceTimestamps);
      const existing = traceTimestamps.get(span.trace_id) ?? {
        first_ts: span.start_ts,
        last_ts: span.start_ts,
        span_count: 0,
        active: false,
      };
      existing.first_ts = Math.min(existing.first_ts, span.start_ts);
      existing.last_ts = Math.max(existing.last_ts, span.end_ts ?? span.start_ts);
      existing.span_count += 1;
      existing.active = span.end_ts == null || existing.active;
      // Re-evaluate active across all known spans for this trace
      let stillActive = false;
      for (const s of spans.values()) {
        if (s.trace_id === span.trace_id && s.end_ts == null) {
          stillActive = true;
          break;
        }
      }
      existing.active = stillActive;
      traceTimestamps.set(span.trace_id, existing);
      return { spans, traceTimestamps, recentSpanRxTs };
    }),
  setConnected: (v) => set({ connected: v }),
  clear: () => set({ spans: new Map(), traceTimestamps: new Map(), recentSpanRxTs: [] }),
}));

let source: EventSource | null = null;

export function startSse(url = '/events/stream'): void {
  if (source) return;
  source = new EventSource(url);
  source.addEventListener('open', () => useSseStore.getState().setConnected(true));
  source.addEventListener('error', () => useSseStore.getState().setConnected(false));
  source.addEventListener('span', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data) as SpanRecord;
      useSseStore.getState().ingest(data);
    } catch {
      /* malformed event — skip */
    }
  });
}

export function stopSse(): void {
  source?.close();
  source = null;
  useSseStore.getState().setConnected(false);
}

export function spansForTrace(traceId: string): SpanRecord[] {
  const result: SpanRecord[] = [];
  for (const s of useSseStore.getState().spans.values()) {
    if (s.trace_id === traceId) result.push(s);
  }
  return result.sort((a, b) => a.start_ts - b.start_ts);
}
