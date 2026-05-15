# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

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

## Repo Layout

The platform actually lives under `MultiUserAgentPlatform/` (git root). Run all `pnpm` commands from there. Package manager is **pnpm 10.33+** and Node **>=20** (`.nvmrc`).

## Commands

Host process (this package):

```bash
pnpm install
pnpm dev                                # tsx src/index.ts
pnpm build                              # tsc → dist/
pnpm start                              # node dist/index.js
pnpm typecheck                          # tsc --noEmit
pnpm lint                               # eslint src/
pnpm test                               # vitest run (src/ + scripts/ only)
pnpm test -- path/to/file.test.ts       # run a single test file
pnpm test:watch                         # vitest watch
pnpm format                             # prettier write on src/
pnpm init:enterprise                    # tsx scripts/init-enterprise-topology.ts
pnpm configure:enterprise-gateway --base-url <url>
pnpm container:build                    # bash container/build.sh
```

Container-side agent-runner (separate package, **Bun** runtime, not pnpm/Node):

```bash
cd container/agent-runner
bun test                                # uses bun:sqlite — won't run under vitest
bun run typecheck
bun src/index.ts                        # what the container entrypoint runs
```

Critical: `pnpm test` deliberately excludes `container/` because those tests import `bun:sqlite`. To exercise agent-runner code, you must `cd container/agent-runner && bun test`. ESLint is also scoped to `src/` only (`container/` and `groups/` are ignored in `eslint.config.js`).

## Core Shape

- Host: `src/index.ts`, `src/router.ts`, `src/delivery.ts`, `src/host-sweep.ts`
- DB layer (split by entity, numbered migrations): `src/db/`
- Channels: `src/channels/` with `cli` and `feishu`
- Platform modules (a2a, permissions, scheduling, approvals, progress-status, etc.): `src/modules/`
- Enterprise bootstrap: `scripts/init-enterprise-topology.ts`, `scripts/configure-enterprise-gateway.ts`
- Container runner: `container/agent-runner/src/` (poll-loop, providers, mcp-tools, request-identity)
- Container prompt base: `container/CLAUDE.md` (this is the system prompt the agents themselves run with — separate from this file)

## Runtime Model

- The host is a single Node process; the agent-runner is a separate Bun process inside each container.
- Each active session maps to one containerized agent runner.
- **Host ↔ container IO is exclusively a per-session SQLite file pair**: `inbound.db` (host writes, container reads) and `outbound.db` (container writes, host reads). No stdin, no IPC files, no shared writers. Both run in DELETE journal mode (WAL is unreliable across virtiofs / Apple Container mounts). When changing anything that touches these files, preserve the single-writer-per-file invariant — see `src/session-manager.ts` for the cross-mount rules.
- Heartbeat is a file touch at `/workspace/.heartbeat`, not a DB row.
- Long-term business memory lives behind the ERP gateway, not in ad-hoc local files (`memoryMode=erp`).

## Identity Trust Chain

Trust-sensitive tool handlers (the ERP gateway MCP tools are the headline case) must never derive requester identity from the agent's own arguments. Two mechanisms enforce this and should not be bypassed:

1. **Batch-pinned `RequestIdentity`** (`container/agent-runner/src/request-identity.ts`): at the start of each poll batch the runner derives identity from the first triggering `messages_in` row, prefers the host-written `origin_user_id`, and publishes it via `request-context.ts`. Tool handlers read context — they don't re-query the DB at call time. If no source is available, identity is marked `agent-asserted` and the backend may reject writes.
2. **`origin_user_id` traversal** (host): channel inbound leaves it NULL; the a2a module (`src/modules/agent-to-agent/agent-route.ts`) copies it forward so worker sessions see the original employee identity N hops down the delegation chain.

ERP gateway requests carry both the resolved `requester` block and an explicit `requesterSource: 'session' | 'agent-asserted'`. HMAC signing (`signingKey` in container config) and the central `erp_audit` table complete the chain.

## Working Rules

- Prefer keeping enterprise behavior in the gateway contract, not hardcoding ERP-specific logic into the platform core.
- Preserve user/session isolation semantics when changing routing logic — particularly the `per-user` / `per-user-per-thread` paths and the `root-session` a2a worker mode.
- Keep Feishu group-chat behavior conservative; do not widen write permissions based only on group context.
- When cleaning or extending the repo, prefer deleting unused legacy surface over keeping compatibility shims for old product directions.
- Skill-style customization is the intended extension model: channels and MCP tools register themselves, mounts are declarative, env vars are read by the module that needs them. Don't introduce central switch statements or a global config registry that every skill has to patch.
- Prettier: `printWidth: 120`, single quotes. ESLint enforces `no-catch-all` (warn) and `preserve-caught-error` — keep `catch (err)` named and re-throw rather than swallowing.

## Branding Note

The product/package name is **FrontLane** (`frontlane-agent-platform`, `frontlane-frontdesk`, metric prefixes, docs). A handful of low-level runtime identifiers — Docker image names, container labels — still use the legacy `nanoclaw-*` prefix. That mismatch is intentional and documented in `README.md`; don't rename those during unrelated work.

## Useful Docs

- `README.md` — feature list, env vars, quick start (in Chinese)
- `docs/architecture.md` — deep dive on the two-DB IO model, session schema, agent-runner internals
- `docs/enterprise-multi-user.md`
- `docs/enterprise-erp-gateway.md`
- `docs/feishu-channel.md`
- `docs/isolation-model.md` — when to pick `shared` vs `per-user` vs separate agent groups
- `docs/db-central.md`, `docs/db-session.md` — schema references
