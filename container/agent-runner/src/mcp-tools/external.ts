/**
 * External-world MCP tools: web_fetch, exec.
 *
 * web_fetch — single HTTP GET. Returns response body as text. 30s timeout,
 * 1 MB response cap. No retry, no redirect tracing — keep the surface tiny.
 *
 * exec — spawn a child process directly (no shell). Caller supplies cmd +
 * arg array; we feed them to child_process.spawn with shell=false to avoid
 * injection. 30s wall-clock cap, 256 KB stdout/stderr cap each.
 *
 * Both tools are synchronous from the agent's POV — handler awaits the
 * result and returns it. No fire-and-forget pattern, no host-side approval.
 * The container already runs unprivileged; these tools just give the
 * runtime parity with what openclaw's exec agent has.
 */
import { spawn } from 'child_process';

import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

const FETCH_TIMEOUT_MS = 30_000;
const FETCH_BODY_CAP = 1_000_000;
const EXEC_TIMEOUT_MS = 30_000;
const EXEC_OUTPUT_CAP = 256_000;

export const webFetch: McpToolDefinition = {
  tool: {
    name: 'web_fetch',
    description:
      'HTTP GET a URL and return the response body as text. 30s timeout, 1MB cap. Use for arxiv/Semantic Scholar/web pages.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string', description: 'Absolute URL (http:// or https://) to GET' },
        headers: {
          type: 'object',
          description: 'Optional HTTP headers to send (e.g. {"Accept":"application/json"})',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['url'],
    },
  },
  async handler(args) {
    const url = String(args.url ?? '');
    if (!/^https?:\/\//.test(url)) return err('url must start with http:// or https://');
    const headers = (args.headers as Record<string, string> | undefined) ?? {};
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal });
      const reader = res.body?.getReader();
      let received = 0;
      const chunks: Uint8Array[] = [];
      let truncated = false;
      if (reader) {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.length;
          if (received > FETCH_BODY_CAP) {
            truncated = true;
            chunks.push(value.subarray(0, value.length - (received - FETCH_BODY_CAP)));
            controller.abort();
            break;
          }
          chunks.push(value);
        }
      }
      const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      const ct = res.headers.get('content-type') ?? '';
      const text = buf.toString('utf8');
      log(`web_fetch: ${url} -> ${res.status} (${buf.length}B${truncated ? ', truncated' : ''})`);
      return ok(
        JSON.stringify({
          status: res.status,
          content_type: ct,
          truncated,
          bytes: buf.length,
          text,
        }),
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log(`web_fetch failed: ${url} -> ${msg}`);
      return err(`web_fetch failed: ${msg}`);
    } finally {
      clearTimeout(t);
    }
  },
};

export const exec: McpToolDefinition = {
  tool: {
    name: 'exec',
    description:
      'Run a command directly (no shell, no expansion). Supply args as an array. 30s wall-clock cap. Returns {exit_code, stdout, stderr}.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        cmd: { type: 'string', description: 'Executable name or absolute path' },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Argument list (no shell expansion)',
        },
        timeout_ms: {
          type: 'number',
          description: 'Optional wall-clock timeout in milliseconds (default 30000, max 30000)',
        },
        cwd: { type: 'string', description: 'Optional working directory' },
      },
      required: ['cmd'],
    },
  },
  async handler(args) {
    const cmd = String(args.cmd ?? '');
    if (!cmd) return err('cmd is required');
    const argv = Array.isArray(args.args) ? (args.args as unknown[]).map(String) : [];
    const requested = Number(args.timeout_ms ?? EXEC_TIMEOUT_MS);
    const timeoutMs = Math.min(Math.max(requested, 100), EXEC_TIMEOUT_MS);
    const cwd = args.cwd ? String(args.cwd) : undefined;

    return new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let stdoutCapped = false;
      let stderrCapped = false;
      let timedOut = false;

      const child = spawn(cmd, argv, { cwd, shell: false });
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 1000);
      }, timeoutMs);

      child.stdout.on('data', (b: Buffer) => {
        if (stdoutCapped) return;
        stdout += b.toString('utf8');
        if (stdout.length > EXEC_OUTPUT_CAP) {
          stdout = stdout.slice(0, EXEC_OUTPUT_CAP);
          stdoutCapped = true;
        }
      });
      child.stderr.on('data', (b: Buffer) => {
        if (stderrCapped) return;
        stderr += b.toString('utf8');
        if (stderr.length > EXEC_OUTPUT_CAP) {
          stderr = stderr.slice(0, EXEC_OUTPUT_CAP);
          stderrCapped = true;
        }
      });
      child.on('error', (e: Error) => {
        clearTimeout(timer);
        log(`exec spawn error: ${cmd} -> ${e.message}`);
        resolve(err(`exec spawn failed: ${e.message}`));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        log(`exec: ${cmd} ${argv.join(' ').slice(0, 80)} -> exit=${code} signal=${signal ?? '-'} timedOut=${timedOut}`);
        resolve(
          ok(
            JSON.stringify({
              exit_code: code,
              signal: signal ?? null,
              timed_out: timedOut,
              stdout_truncated: stdoutCapped,
              stderr_truncated: stderrCapped,
              stdout,
              stderr,
            }),
          ),
        );
      });
    });
  },
};

registerTools([webFetch, exec]);
