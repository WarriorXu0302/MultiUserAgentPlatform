# Observability — nano-monitor

Real-time trace + data-flow + token + tool dashboard for the FrontLane agent
platform. Custom-built for the platform's topology (per-session container,
a2a delegation, heartbeat sweep, channel adapter) — generic LLM trace UIs
can't express these well.

## Pieces

| Component                                                | Where                                                                    | Owner   |
| -------------------------------------------------------- | ------------------------------------------------------------------------ | ------- |
| Central `trace_events` table                             | `data/v2.db`, created by migration 024                                   | host    |
| Per-session `trace_spans` buffer                         | `data/v2-sessions/<ag>/<sess>/outbound.db`, forward-compat on container spawn | container |
| Host EventBus + persistor + abandoned-span reaper        | `src/observability/event-bus.ts`                                         | host    |
| Container watcher (drains per-session `trace_spans`)     | `src/observability/container-watcher.ts`                                 | host    |
| REST + SSE endpoints                                     | `src/observability/api.ts`                                               | host    |
| Container span emit helper                               | `container/agent-runner/src/observability/emit.ts`                       | container |
| Vite + React frontend                                    | `apps/monitor/`                                                          | dev only |

## Data flow

```
[host: router / a2a-route / delivery / container-runner]
                │
                ├── emit channel-inbound / a2a-hop / channel-deliver / container-lifecycle spans
                │
                ▼
       traceEventBus.emitSpan()
       ├── persist → v2.db.trace_events
       └── broadcast → SSE clients
                ▲
                │
       container-watcher.tick (every 200ms)
                ▲
                │ SELECT * FROM trace_spans WHERE seq > last_seen
                │
[container: poll-loop / providers / mcp-tools]
                │
                └── emit.startSpan / endSpan → outbound.db.trace_spans
```

Container-to-host IO stays on the per-session file pair, in line with the
"no stdin / no IPC files" invariant in `CLAUDE.md`.

## Span kinds

| kind                 | Emitted by                                                  | Required attributes                                                                                                                       |
| -------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `channel-inbound`    | host `src/router.ts` on channel ingress                     | `platform` / `messageId` / `chatId` / `senderId` / `wake` / `engage_mode`                                                                 |
| `agent-turn`         | container `poll-loop.ts:processQuery`                       | `container_name` / `message_count` / `batch_kinds` / `continuation`                                                                       |
| `llm-call`           | container `providers/openai.ts` and `providers/claude.ts`   | `model` / `provider` / `transport` / `input_tokens` / `output_tokens` / `total_tokens` / `duration_ms` / `prompt` / `completion`         |
| `tool-exec`          | container `mcp-tools/server.ts` `CallToolRequestSchema` wrap | `tool_name` / `arguments` / `result` / `exit_code` / `stderr_excerpt`                                                                     |
| `a2a-hop`            | host `src/modules/agent-to-agent/agent-route.ts`            | `from_agent` / `to_agent` / `target_session` / `a2a_msg_id` / `origin_user_id`                                                            |
| `channel-deliver`    | host `src/delivery.ts` success callback                     | `platform` / `platform_msg_id` / `latency_ms`                                                                                             |
| `container-lifecycle`| host `src/container-runner.ts` spawn + close                | `event` (`spawn` / `exit`) / `outcome` (`idle` / `crash` / `killed`) / `agent_group_id` / `session_id`                                    |

Attribute strings (`prompt`, `completion`, `arguments`, `result`) are
truncated to 32KB (configurable via `FRONTLANE_MONITOR_PROMPT_LIMIT`). The
full payload, if larger, is dropped — there is no spillover file in the MVP.

## trace_id

Existing UUID v4, generated once at channel ingress (`src/router.ts`),
copied verbatim across a2a hops. The monitor does not change the format —
upgrading to W3C `traceparent` is a future-Phase concern that requires only
a writer-side switch plus a tolerant parser.

## Configuration

| Env                                | Default                  | Component       |
| ---------------------------------- | ------------------------ | --------------- |
| `FRONTLANE_MONITOR_POLL_MS`        | `200`                    | host watcher    |
| `FRONTLANE_MONITOR_PROMPT_LIMIT`   | `32768`                  | container emit  |
| `FRONTLANE_MONITOR_CORS_ORIGIN`    | `*`                      | host api        |
| `FRONTLANE_MONITOR_PORT`           | `3001`                   | apps/monitor    |
| `FRONTLANE_MONITOR_BACKEND_PORT`   | `3000`                   | apps/monitor    |

## How to bring it online (Step B work — host restart required)

The Step A code already merged is purely additive: schemas, modules, and
the frontend skeleton. Wiring is intentionally deferred until a host
restart window is approved. Step B work consists of:

1. **`src/index.ts`**: after `initDb(...)` and after migrations have run,
   call `reapAbandonedSpans()` and `startContainerSpanWatcher()` and
   `registerMonitorEndpoints()` from `src/observability/`.
2. **`src/router.ts:536`**: emit `channel-inbound` span. End it after the
   `writeSessionMessage` returns.
3. **`src/modules/agent-to-agent/agent-route.ts:290-315`**: emit
   `a2a-hop` span around the cross-session forward.
4. **`src/delivery.ts`**: emit `channel-deliver` span on successful
   platform send.
5. **`src/container-runner.ts:172` / `:236`**: emit `container-lifecycle`
   spans on spawn / close.
6. **`container/agent-runner/src/poll-loop.ts:processQuery`**: wrap in
   `withSpan({kind: 'agent-turn', ...})`. Pull `trace_id` from the first
   triggering inbound row.
7. **`container/agent-runner/src/providers/openai.ts:770-798`**: wrap
   `runTurn` in `withSpan({kind: 'llm-call', ...})`.
8. **`container/agent-runner/src/providers/claude.ts:311-339`**: wrap
   `translateEvents`; also wire usage extraction from SDK messages
   (`message.message.usage`) and `yield` it via the existing `usage`
   ProviderEvent.
9. **`container/agent-runner/src/mcp-tools/server.ts:42-48`**: wrap the
   `CallToolRequestSchema` handler dispatch in `withSpan({kind:
   'tool-exec', ...})`.
10. **`container/agent-runner/src/db/messages-in.ts:MessageInRow`**: add
    `trace_id: string | null` so callers (poll-loop) can read it.

After all of the above, restart the host (`pnpm dev`) and start the
frontend (`pnpm --filter frontlane-monitor dev`). The two activate
together — first turn after restart should appear on `http://localhost:3001`
within a second.

## Known gaps

- **Claude SDK built-in tools** (Bash / Read / Edit / Glob / Grep / Task /
  Web*) bypass our MCP server and so don't produce `tool-exec` spans. The
  `PreToolUse` / `PostToolUse` hooks at `claude.ts:300-305` could close
  this, but the SDK callback signatures don't currently expose full
  tool input/output. Treated as deferred work.
- **Long prompts > 32 KB** are silently truncated. No spillover file yet.
- **Privacy**: `prompt` / `completion` / `arguments` / `result` are stored
  in plaintext. Production should set `FRONTLANE_MONITOR_REDACT=full` (not
  yet implemented) or run the host with a tighter `CORS_ORIGIN` so the
  frontend isn't accessible off-host.
- **trace_id format is still UUID, not W3C traceparent** — fine for now;
  upgrade is local to `src/router.ts` + a tolerant parser.

## Why custom (and not Phoenix / Langfuse)

See ADR / plan file `~/.claude/plans/valiant-mapping-meteor.md` for the
trade-off. Short version: the platform's per-session container, a2a
delegation tree, and heartbeat sweep semantics are first-class concepts
here, not retrofits. Phoenix and Langfuse give us LLM-call timelines well
but bury the rest. The existing Langfuse sidecar
(`scripts/observability/langfuse-sidecar.ts`) is still running and
unaffected; deprecate or keep based on whether you want a parallel
"business audit" surface.
