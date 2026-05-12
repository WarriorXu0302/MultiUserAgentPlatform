import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from './db/index.js';
import { findClassificationById, recordClassification } from './db/classification-log.js';
import { reconcileClassification } from './delivery.js';
import { classificationBypassTotal } from './metrics.js';

async function bypassCount(reason: string, surface: string): Promise<number> {
  const all = await classificationBypassTotal.get();
  const match = all.values.find((v) => v.labels.reason === reason && v.labels.surface === surface);
  return match?.value ?? 0;
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  classificationBypassTotal.reset();
});

afterEach(() => {
  closeDb();
});

const SESS = 'sess-1';

describe('reconcileClassification', () => {
  it('bumps no_classification_id when the outbound has no id field', async () => {
    const before = await bypassCount('no_classification_id', 'agent_send');
    reconcileClassification({ text: 'hi' }, 'out-1', 'agent_send', SESS);
    expect(await bypassCount('no_classification_id', 'agent_send')).toBe(before + 1);
  });

  it('bumps classification_not_found when id is present but not in the log', async () => {
    reconcileClassification({ text: 'hi', _classificationId: 'cls-ghost' }, 'out-1', 'agent_send', SESS);
    expect(await bypassCount('classification_not_found', 'agent_send')).toBe(1);
  });

  it('stamps outcome_ref when id matches a log row (same session)', async () => {
    recordClassification({
      action: 'delegate',
      classificationId: 'cls-001',
      sessionId: SESS,
      recommendedWorker: 'finance-worker',
      confidence: 0.9,
    });
    reconcileClassification(
      { text: 'please handle this', _classificationId: 'cls-001' },
      'out-xyz',
      'agent_send',
      SESS,
    );
    const row = findClassificationById('cls-001')!;
    expect(row.outcome_ref).toBe('out-xyz');
  });

  it('refuses to stamp across sessions (cross-session id reuse is bypass)', async () => {
    recordClassification({
      action: 'delegate',
      classificationId: 'cls-crossborrow',
      sessionId: 'sess-other',
      recommendedWorker: 'finance-worker',
      confidence: 0.9,
    });
    reconcileClassification(
      { text: 'trying to link', _classificationId: 'cls-crossborrow' },
      'out-from-sess-1',
      'agent_send',
      SESS,
    );
    // Treated like "not found from this session's perspective".
    expect(await bypassCount('classification_not_found', 'agent_send')).toBe(1);
    // And the other session's row stays untouched.
    expect(findClassificationById('cls-crossborrow')?.outcome_ref).toBeNull();
  });

  it('bumps action_mismatch when declared action does not match surface', async () => {
    recordClassification({
      action: 'clarify',
      classificationId: 'cls-clarify-then-send',
      sessionId: SESS,
      recommendedWorker: null,
      confidence: 0.5,
    });
    reconcileClassification(
      { text: 'going straight to worker', _classificationId: 'cls-clarify-then-send' },
      'out-2',
      'agent_send',
      SESS,
    );
    expect(await bypassCount('action_mismatch', 'agent_send')).toBe(1);
    // Still stamps outcome_ref — the link is more valuable than the guard.
    expect(findClassificationById('cls-clarify-then-send')?.outcome_ref).toBe('out-2');
  });

  it('matches clarify action with ask_user_question surface', async () => {
    recordClassification({
      action: 'clarify',
      classificationId: 'cls-ok-clarify',
      sessionId: SESS,
      confidence: 0.5,
    });
    reconcileClassification(
      { type: 'ask_question', _classificationId: 'cls-ok-clarify' },
      'card-1',
      'ask_user_question',
      SESS,
    );
    expect(await bypassCount('action_mismatch', 'ask_user_question')).toBe(0);
    expect(findClassificationById('cls-ok-clarify')?.outcome_ref).toBe('card-1');
  });

  it('matches answer_self action with channel_send surface', async () => {
    recordClassification({
      action: 'answer_self',
      classificationId: 'cls-answer',
      sessionId: SESS,
      confidence: 0.9,
    });
    reconcileClassification(
      { text: 'answering you directly', _classificationId: 'cls-answer' },
      'msg-reply',
      'channel_send',
      SESS,
    );
    expect(await bypassCount('action_mismatch', 'channel_send')).toBe(0);
    expect(findClassificationById('cls-answer')?.outcome_ref).toBe('msg-reply');
  });

  it('does not throw when the log table query fails inside try', () => {
    expect(() =>
      reconcileClassification({ _classificationId: 42 }, 'out-1', 'agent_send', SESS),
    ).not.toThrow();
  });
});
