import { describe, expect, it } from 'bun:test';

import { shouldExitIdle } from './poll-loop.js';

describe('shouldExitIdle', () => {
  it('never exits when idleExitMs is 0 (feature off)', () => {
    expect(shouldExitIdle(0, 0, 999_999)).toBe(false);
  });

  it('never exits when idleExitMs is negative', () => {
    expect(shouldExitIdle(-100, 0, 999_999)).toBe(false);
  });

  it('does not exit when elapsed time is below the window', () => {
    expect(shouldExitIdle(10_000, 1000, 5000)).toBe(false);
  });

  it('exits when elapsed time has reached the window', () => {
    expect(shouldExitIdle(10_000, 0, 10_000)).toBe(true);
  });

  it('exits when elapsed time has passed the window', () => {
    expect(shouldExitIdle(10_000, 0, 20_000)).toBe(true);
  });
});
