/**
 * Per-batch context the poll loop publishes for downstream consumers
 * (MCP tools, etc.) that don't sit on the poll-loop's call stack.
 *
 * Today the only field is `inReplyTo` — the id of the first inbound
 * message in the batch the agent is currently processing. MCP tools like
 * `send_message` and `send_file` read this and stamp it onto the outbound
 * row so the host's a2a return-path routing can correlate replies back to
 * the originating session.
 *
 * This is module-level state on purpose: the agent-runner is single-process
 * and processes one batch at a time. Poll-loop calls `setCurrentInReplyTo`
 * before invoking the provider and `clearCurrentInReplyTo` after the batch
 * completes (or errors out).
 */
let currentInReplyTo: string | null = null;

export function setCurrentInReplyTo(id: string | null): void {
  currentInReplyTo = id;
}

export function clearCurrentInReplyTo(): void {
  currentInReplyTo = null;
}

export function getCurrentInReplyTo(): string | null {
  return currentInReplyTo;
}

/**
 * The most recent classificationId emitted by this turn's classify_intent
 * call(s). Populated by the tool itself (not by poll-loop) so the final
 * <message to="..."> dispatcher can auto-stamp it onto outbound rows —
 * LLMs can't inject the id into the XML form, so without this path
 * every delegation via the main <message> protocol would bypass the
 * classification audit loop.
 *
 * Single-valued (not a stack): the runner processes one turn at a
 * time, and multiple classify_intent calls in the same turn represent
 * re-classification — last write wins, which matches the semantics the
 * host-side reconcile expects (outcome_ref is first-write-wins, so
 * only the last classification-id forwarded matters for the link).
 */
let currentClassificationId: string | null = null;

export function setCurrentClassificationId(id: string | null): void {
  currentClassificationId = id;
}

export function clearCurrentClassificationId(): void {
  currentClassificationId = null;
}

export function getCurrentClassificationId(): string | null {
  return currentClassificationId;
}

