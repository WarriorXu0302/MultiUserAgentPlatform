import { describe, expect, it } from 'vitest';

import { shouldAdmitWake } from './container-runner.js';

describe('shouldAdmitWake', () => {
  it('admits when nothing is running', () => {
    expect(shouldAdmitWake({ activeCount: 0, inflightCount: 0, cap: 10 })).toBe(true);
  });

  it('admits up to cap - 1', () => {
    expect(shouldAdmitWake({ activeCount: 9, inflightCount: 0, cap: 10 })).toBe(true);
  });

  it('rejects at exactly cap', () => {
    // 10 active + 0 in-flight == cap → the incoming wake would make it 11.
    expect(shouldAdmitWake({ activeCount: 10, inflightCount: 0, cap: 10 })).toBe(false);
  });

  it('rejects beyond cap', () => {
    expect(shouldAdmitWake({ activeCount: 12, inflightCount: 0, cap: 10 })).toBe(false);
  });

  it('counts in-flight wakes against the cap', () => {
    // Active is only 7, but there are 3 wakes mid-spawn — those will become
    // active any moment, so the next one must be refused.
    expect(shouldAdmitWake({ activeCount: 7, inflightCount: 3, cap: 10 })).toBe(false);
    expect(shouldAdmitWake({ activeCount: 7, inflightCount: 2, cap: 10 })).toBe(true);
  });

  it('honors a lower cap (small deployments)', () => {
    expect(shouldAdmitWake({ activeCount: 0, inflightCount: 0, cap: 1 })).toBe(true);
    expect(shouldAdmitWake({ activeCount: 1, inflightCount: 0, cap: 1 })).toBe(false);
  });
});
