/**
 * FrontLane Agent Runner v2
 *
 * Runs inside a container. All IO goes through the session DB.
 * No stdin, no stdout markers, no IPC files.
 *
 * Config is read from /workspace/agent/container.json (mounted RO).
 * Only TZ and OneCLI networking vars come from env.
 *
 * Mount structure:
 *   /workspace/
 *     inbound.db        ← host-owned session DB (container reads only)
 *     outbound.db       ← container-owned session DB
 *     .heartbeat        ← container touches for liveness detection
 *     outbox/           ← outbound files
 *     agent/            ← agent group folder (CLAUDE.md, container.json, working files)
 *       container.json  ← per-group config (RO nested mount)
 *     global/           ← shared global memory (RO)
 *   /app/src/           ← shared agent-runner source (RO)
 *   /app/skills/        ← shared skills (RO)
 *   /home/node/.claude/ ← Claude SDK state + skill symlinks (RW)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { loadConfig } from './config.js';
import { buildSystemPromptAddendum } from './destinations.js';
// Providers barrel — each enabled provider self-registers on import.
// Provider skills append imports to providers/index.ts.
import './providers/index.js';
import { createProvider, type ProviderName } from './providers/factory.js';
import { runPollLoop } from './poll-loop.js';

function log(msg: string): void {
  console.error(`[agent-runner] ${msg}`);
}

const CWD = '/workspace/agent';

/**
 * Read the composed CLAUDE.md, inline its `@./...` imports, and append
 * CLAUDE.local.md. Used for providers that don't auto-load these files.
 *
 * The composed CLAUDE.md is a list of imports (see claude-md-compose.ts on
 * the host). Each `@./path` line resolves to a host-side file or a symlink
 * that points to a container-side path; both work because the runtime is
 * already inside the container.
 */
function readComposedClaudeMd(cwd: string): string {
  const out: string[] = [];
  const entry = path.join(cwd, 'CLAUDE.md');
  let composedText = '';
  try {
    composedText = fs.readFileSync(entry, 'utf8');
  } catch {
    return '';
  }
  for (const rawLine of composedText.split('\n')) {
    const line = rawLine.trim();
    const m = line.match(/^@(\S+)$/);
    if (!m) {
      out.push(rawLine);
      continue;
    }
    const ref = m[1];
    const target = ref.startsWith('./') ? path.join(cwd, ref.slice(2)) : ref;
    try {
      out.push(fs.readFileSync(target, 'utf8'));
    } catch {
      // missing import — skip silently
    }
  }
  // Append per-group memory (CLAUDE.local.md) so persona + dispatch rules
  // edited by operators reach providers that bypass Claude Code's auto-loader.
  try {
    const local = fs.readFileSync(path.join(cwd, 'CLAUDE.local.md'), 'utf8').trim();
    if (local) {
      out.push('');
      out.push('# Per-group memory (CLAUDE.local.md)');
      out.push('');
      out.push(local);
    }
  } catch {
    // optional
  }
  return out.join('\n').trim();
}

async function main(): Promise<void> {
  const config = loadConfig();
  const providerName = config.provider.toLowerCase() as ProviderName;

  log(`Starting v2 agent-runner (provider: ${providerName})`);

  // Runtime-generated system-prompt addendum: agent identity, memory
  // policy, and the live destinations map.
  const addendum = buildSystemPromptAddendum(config.assistantName || undefined, config.memoryMode);

  // For providers that don't auto-load CLAUDE.md (e.g. openai/qwen), inline
  // the composed entry, its @-imports, and CLAUDE.local.md so per-group
  // dispatch rules, skill fragments, and persona actually reach the LLM.
  // Claude provider keeps the SDK auto-load path and doesn't need this.
  const composedBlock = providerName === 'claude' ? '' : readComposedClaudeMd(CWD);
  const instructions = [composedBlock, addendum].filter(Boolean).join('\n\n');

  // Discover additional directories mounted at /workspace/extra/*
  const additionalDirectories: string[] = [];
  const extraBase = '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        additionalDirectories.push(fullPath);
      }
    }
    if (additionalDirectories.length > 0) {
      log(`Additional directories: ${additionalDirectories.join(', ')}`);
    }
  }

  // MCP server path — bun runs TS directly; no tsc build step in-image.
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const mcpServerPath = path.join(__dirname, 'mcp-tools', 'index.ts');

  // Build MCP servers config: frontlane built-in + any from container.json
  const mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> = {
    frontlane: {
      command: 'bun',
      args: ['run', mcpServerPath],
      env: {},
    },
  };

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    mcpServers[name] = serverConfig;
    log(`Additional MCP server: ${name} (${serverConfig.command})`);
  }

  const provider = createProvider(providerName, {
    assistantName: config.assistantName || undefined,
    mcpServers,
    env: { ...process.env },
    additionalDirectories: additionalDirectories.length > 0 ? additionalDirectories : undefined,
  });

  await runPollLoop({
    provider,
    providerName,
    cwd: CWD,
    systemContext: { instructions },
    idleExitMs: config.idleExitMs,
  });
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
