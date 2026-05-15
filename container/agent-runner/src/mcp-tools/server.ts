/**
 * MCP server bootstrap + tool self-registration.
 *
 * Each tool module calls `registerTools([...])` at import time. The
 * barrel (`index.ts`) imports every tool module for side effects, then
 * calls `startMcpServer()` which uses whatever was registered.
 *
 * Default when only `core.ts` is imported: the core `send_message` /
 * `send_file` / `edit_message` / `add_reaction` tools are available.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { endSpan, getCurrentSpan, startSpan, truncate } from '../observability/emit.js';

import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

const allTools: McpToolDefinition[] = [];
const toolMap = new Map<string, McpToolDefinition>();

export function registerTools(tools: McpToolDefinition[]): void {
  for (const t of tools) {
    if (toolMap.has(t.tool.name)) {
      log(`Warning: tool "${t.tool.name}" already registered, skipping duplicate`);
      continue;
    }
    allTools.push(t);
    toolMap.set(t.tool.name, t);
  }
}

export async function startMcpServer(): Promise<void> {
  const server = new Server({ name: 'frontlane', version: '2.0.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: allTools.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const tool = toolMap.get(name);
    if (!tool) {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
    }
    // nano-monitor: tool-execution span. Skipped when no agent-turn is
    // active (e.g. test/init flows) — the parent context comes from poll-loop.
    const parent = getCurrentSpan();
    const argsJson = JSON.stringify(args ?? {});
    const span = parent
      ? startSpan({
          trace_id: parent.trace_id,
          parent_span_id: parent.span_id,
          name: `tool.${name}`,
          kind: 'tool-execution',
          attributes: {
            // OpenInference semconv
            'tool.name': name,
            'tool.parameters': argsJson.slice(0, 4096),
            'input.value': argsJson.slice(0, 4096),
            // P0-B-tool required fields
            tool_name: name,
            args_summary: argsJson.slice(0, 200),
            attempt_num: 1,
          },
        })
      : null;
    const t0 = Date.now();
    try {
      const result = await tool.handler(args ?? {});
      if (span) {
        const resultJson = JSON.stringify(result);
        endSpan(span, {
          status: 'ok',
          attributesPatch: {
            'tool.output': resultJson.slice(0, 4096),
            'output.value': resultJson.slice(0, 4096),
            exit_code: 0,
            duration_ms: Date.now() - t0,
            result: resultJson.slice(0, 4096),
          },
        });
      }
      return result;
    } catch (err) {
      if (span) {
        endSpan(span, {
          status: 'error',
          attributesPatch: {
            exit_code: 1,
            duration_ms: Date.now() - t0,
            error_message: (err as Error)?.message ?? String(err),
          },
        });
      }
      throw err;
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`MCP server started with ${allTools.length} tools: ${allTools.map((t) => t.tool.name).join(', ')}`);
}
