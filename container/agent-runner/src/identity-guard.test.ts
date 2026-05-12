import { describe, expect, it } from 'bun:test';

import { shouldEndForIdentityChange, shouldEndForTurnChange, type TurnContext } from './poll-loop.js';

function tc(partial: Partial<TurnContext>): TurnContext {
  return {
    userId: null,
    channelType: null,
    platformId: null,
    threadId: null,
    source: 'session',
    ...partial,
  };
}

describe('shouldEndForTurnChange (new)', () => {
  it('does not end when there is no current turn', () => {
    expect(shouldEndForTurnChange(null, tc({ userId: 'a' }))).toBe(false);
  });

  it('does not end when current is agent-asserted', () => {
    expect(
      shouldEndForTurnChange(
        tc({ userId: 'a', source: 'agent-asserted' }),
        tc({ userId: 'b', source: 'session' }),
      ),
    ).toBe(false);
  });

  it('does not end when incoming is agent-asserted', () => {
    expect(
      shouldEndForTurnChange(
        tc({ userId: 'a', source: 'session' }),
        tc({ userId: null, source: 'agent-asserted' }),
      ),
    ).toBe(false);
  });

  it('does not end when same user, same routing', () => {
    expect(
      shouldEndForTurnChange(
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:p1', threadId: 't1' }),
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:p1', threadId: 't1' }),
      ),
    ).toBe(false);
  });

  it('ends when the user changes', () => {
    expect(
      shouldEndForTurnChange(
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:p1' }),
        tc({ userId: 'b', channelType: 'feishu', platformId: 'feishu:p1' }),
      ),
    ).toBe(true);
  });

  it('ends when the same user switches channelType', () => {
    // Hypothetical multi-adapter: same user opening a Slack thread
    // while their Feishu turn is in progress. Must not merge.
    expect(
      shouldEndForTurnChange(
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:p1' }),
        tc({ userId: 'a', channelType: 'slack', platformId: 'slack:C1' }),
      ),
    ).toBe(true);
  });

  it('ends when the same user switches platform (group -> DM)', () => {
    // The headline case: Alice asked in group A, then pinged in DM
    // mid-turn. We must not answer her DM into group A.
    expect(
      shouldEndForTurnChange(
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:oc_group_A' }),
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:p2p:ou_a' }),
      ),
    ).toBe(true);
  });

  it('ends when the same user switches threads on the same chat', () => {
    expect(
      shouldEndForTurnChange(
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:oc_group_A', threadId: 't1' }),
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:oc_group_A', threadId: 't2' }),
      ),
    ).toBe(true);
  });

  it('does not end when threadId moves between null and empty-string (treated equivalently via ?? null)', () => {
    // Belt-and-suspenders — don't thrash a turn because one row has
    // thread_id='' and another has null.
    expect(
      shouldEndForTurnChange(
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:p1', threadId: null }),
        tc({ userId: 'a', channelType: 'feishu', platformId: 'feishu:p1', threadId: null }),
      ),
    ).toBe(false);
  });

  it('does not end when current userId is null (no turn to protect)', () => {
    expect(
      shouldEndForTurnChange(tc({ userId: null }), tc({ userId: 'a' })),
    ).toBe(false);
  });
});

describe('shouldEndForIdentityChange (legacy wrapper)', () => {
  // Kept so callers that only cared about userId still get a stable predicate.
  it('ends when a DIFFERENT session-trusted user arrives', () => {
    expect(
      shouldEndForIdentityChange(
        { userId: 'feishu:ou_alice', source: 'session' },
        { userId: 'feishu:ou_bob', source: 'session' },
      ),
    ).toBe(true);
  });

  it('does not end when both sides are the same session user', () => {
    expect(
      shouldEndForIdentityChange(
        { userId: 'feishu:ou_alice', source: 'session' },
        { userId: 'feishu:ou_alice', source: 'session' },
      ),
    ).toBe(false);
  });
});
