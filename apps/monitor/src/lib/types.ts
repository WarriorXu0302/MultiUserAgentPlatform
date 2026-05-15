// Shared types — must stay in sync with src/observability/event-bus.ts.

export type SpanKind =
  | 'channel-inbound'
  | 'agent-turn'
  | 'llm-call'
  | 'llm-generation'
  | 'tool-exec'
  | 'tool-execution'
  | 'a2a-hop'
  | 'channel-deliver'
  | 'container-lifecycle';

export type SpanStatus = 'in_flight' | 'ok' | 'error' | 'abandoned';

export interface SpanRecord {
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  kind: SpanKind;
  start_ts: number;
  end_ts: number | null;
  status: SpanStatus | null;
  agent_group_id: string | null;
  session_id: string | null;
  attributes: Record<string, unknown>;
}

export interface TraceListEntry {
  trace_id: string;
  start_ts: number;
  last_ts: number;
  duration_ms: number;
  span_count: number;
  active: boolean;
  agent_group_id: string | null;
  session_id: string | null;
  llm_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
}

export interface ContainerEntry {
  session_id: string;
  agent_group_id: string;
  container_status: string | null;
  last_active: string | null;
  status: string;
}

export interface TopologyResponse {
  nodes: Array<{ id: string }>;
  edges: Array<{ from: string; to: string; count: number; avg_latency_ms: number | null }>;
  windowMin: number;
}
