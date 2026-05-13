/**
 * Shared helper: compute origin_user_id for outbound rows that route to
 * another agent group. Extracted here so both MCP-tool paths (core.ts)
 * and the final-<message> dispatcher path (poll-loop.ts) can use the
 * same rule.
 *
 * Returns null for non-a2a (channel) destinations — the host already
 * has the identity on the source inbound row. Also returns null when
 * the current turn's identity is agent-asserted (i.e. not trusted),
 * so the host-side a2a router falls back to its own lookup instead
 * of us stamping a forged value.
 */
import { getRequestIdentity } from './request-context.js';

export function a2aOriginUserId(channelType: string): string | null {
  if (channelType !== 'agent') return null;
  const identity = getRequestIdentity();
  if (!identity || identity.source !== 'session') return null;
  return identity.userId ?? null;
}
