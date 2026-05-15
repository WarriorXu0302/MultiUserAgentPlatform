import type { ContainerEntry, SpanRecord, TopologyResponse, TraceListEntry } from './types';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchTraces(opts: { limit?: number; since?: number } = {}): Promise<TraceListEntry[]> {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set('limit', String(opts.limit));
  if (opts.since != null) q.set('since', String(opts.since));
  const data = await getJson<{ traces: TraceListEntry[] }>(`/api/traces?${q}`);
  return data.traces;
}

export async function fetchTrace(traceId: string): Promise<SpanRecord[]> {
  const data = await getJson<{ spans: SpanRecord[] }>(`/api/trace?id=${encodeURIComponent(traceId)}`);
  return data.spans;
}

export async function fetchContainers(): Promise<ContainerEntry[]> {
  const data = await getJson<{ containers: ContainerEntry[] }>(`/api/containers`);
  return data.containers;
}

export async function fetchTopology(windowMin = 60): Promise<TopologyResponse> {
  return getJson<TopologyResponse>(`/api/topology?windowMin=${windowMin}`);
}
