import { describe, expect, it } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import { extractRouting } from './formatter.js';
import { splitBatchByTurn } from './request-identity.js';

function row(partial: Partial<MessageInRow> & { id: string }): MessageInRow {
  return {
    seq: 2,
    kind: 'chat',
    timestamp: '2026-05-13T00:00:00Z',
    status: 'pending',
    process_after: null,
    recurrence: null,
    tries: 0,
    trigger: 1,
    platform_id: 'feishu:p2p:ou_alice',
    channel_type: 'feishu',
    thread_id: null,
    content: JSON.stringify({ senderId: 'feishu:ou_alice' }),
    origin_user_id: null,
    ...partial,
  };
}

describe('turn routing after batch split', () => {
  it('deferred oldest row would have wrongly anchored routing without recompute', () => {
    // Scenario from the review: oldest row in the batch is an accumulated
    // Bob message (trigger=0), newest is Alice's trigger=1. Anchor
    // identity picks Alice (first trigger=1 chat row), but extractRouting
    // picks the first message in the batch — Bob. If we use pre-split
    // routing for the Alice turn, all Alice's tool calls and error
    // replies get Bob's thread / in_reply_to stamped.
    const bobAccumulated = row({
      id: 'bob-1',
      trigger: 0,
      content: JSON.stringify({ senderId: 'feishu:ou_bob' }),
      platform_id: 'feishu:p2p:ou_bob',
      thread_id: 'bob-thread',
    });
    const aliceTrigger = row({
      id: 'alice-1',
      trigger: 1,
      content: JSON.stringify({ senderId: 'feishu:ou_alice' }),
      platform_id: 'feishu:p2p:ou_alice',
      thread_id: 'alice-thread',
    });
    const batch = [bobAccumulated, aliceTrigger];

    // Pre-split routing: first row is Bob.
    const preSplit = extractRouting(batch);
    expect(preSplit.platformId).toBe('feishu:p2p:ou_bob');
    expect(preSplit.threadId).toBe('bob-thread');
    expect(preSplit.inReplyTo).toBe('bob-1');

    // Split defers Bob; keep contains only Alice.
    const split = splitBatchByTurn(batch);
    expect(split.defer.map((m) => m.id)).toEqual(['bob-1']);
    expect(split.keep.map((m) => m.id)).toEqual(['alice-1']);

    // Post-split routing must use Alice, not Bob.
    const postSplit = extractRouting(split.keep);
    expect(postSplit.platformId).toBe('feishu:p2p:ou_alice');
    expect(postSplit.threadId).toBe('alice-thread');
    expect(postSplit.inReplyTo).toBe('alice-1');
  });

  it('when batch has no split, pre and post routing agree', () => {
    const one = row({ id: 'm1' });
    const two = row({ id: 'm2' });
    const pre = extractRouting([one, two]);
    const { keep } = splitBatchByTurn([one, two]);
    const post = extractRouting(keep);
    expect(post).toEqual(pre);
  });
});
