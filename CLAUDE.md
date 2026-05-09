# FrontLane Agent Platform

This repo is the enterprise baseline for a multi-user agent platform.

## Scope

Keep the project focused on these concerns:

- Feishu and CLI as ingress channels
- frontdesk -> worker delegation
- per-user or per-thread session isolation
- ERP Gateway integration for auth, execute, and long-term memory
- containerized agent execution

Do not reintroduce old personal-assistant, migration, marketplace, or multi-channel fork infrastructure unless explicitly requested.

## Core Shape

- Host: `src/index.ts`, `src/router.ts`, `src/delivery.ts`, `src/host-sweep.ts`
- DB: `src/db/`
- Channels: `src/channels/` with `cli` and `feishu`
- Enterprise bootstrap: `scripts/init-enterprise-topology.ts`, `scripts/configure-enterprise-gateway.ts`
- Container runner: `container/agent-runner/src/`
- Container prompt base: `container/CLAUDE.md`

## Runtime Model

- The host is a single Node process.
- Each active session maps to a containerized agent runner.
- Host and runner communicate through per-session SQLite files.
- Long-term business memory should live behind the ERP gateway, not in ad-hoc local files.

## Working Rules

- Prefer keeping enterprise behavior in the gateway contract, not hardcoding ERP-specific logic into the platform core.
- Preserve user/session isolation semantics when changing routing logic.
- Keep Feishu group-chat behavior conservative; do not widen write permissions based only on group context.
- When cleaning or extending the repo, prefer deleting unused legacy surface over keeping compatibility shims for old product directions.

## Useful Docs

- `README.md`
- `docs/enterprise-multi-user.md`
- `docs/enterprise-erp-gateway.md`
- `docs/feishu-channel.md`
- `docs/architecture.md`
- `docs/isolation-model.md`
