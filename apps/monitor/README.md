# FrontLane Monitor

Real-time observability frontend for the FrontLane (nano) agent platform.

Vite + React + zustand. Talks to host via REST + Server-Sent Events on the
shared webhook server (default port 3000).

## Quick start

```bash
# 1. host must be running with observability wired in (see ../../docs/observability.md)
cd ../..
pnpm install              # picks up apps/monitor as a workspace package
pnpm --filter frontlane-monitor dev
```

Open <http://localhost:3001/>.

## Pages

| Route          | What it shows                                                                            |
| -------------- | ---------------------------------------------------------------------------------------- |
| `/`            | Recent traces with live in-flight indicator                                              |
| `/trace/:id`   | Span timeline + attribute inspector for one trace                                        |
| `/topology`    | A2A delegation edges over a configurable time window                                     |
| `/containers`  | Active sessions and their container status                                               |
| `/tokens`      | LLM call aggregates by model (live SSE buffer only — historical view is a Phase 5 TODO) |

## Configuration

| Env                                | Default                  | Purpose                                              |
| ---------------------------------- | ------------------------ | ---------------------------------------------------- |
| `FRONTLANE_MONITOR_PORT`           | `3001`                   | Vite dev-server port                                 |
| `FRONTLANE_MONITOR_BACKEND_PORT`   | `3000`                   | Host webhook-server port (used by Vite proxy)        |
| `FRONTLANE_MONITOR_CORS_ORIGIN`    | `*` (set on host)        | Tighten to `http://localhost:3001` in prod           |
| `FRONTLANE_MONITOR_POLL_MS`        | `200` (host watcher)     | Container-side span polling interval                 |
| `FRONTLANE_MONITOR_PROMPT_LIMIT`   | `32768` (container emit) | Truncate prompt/completion strings at this byte size |

## Data model

See [`docs/observability.md`](../../docs/observability.md) for span kinds and attribute schema.
