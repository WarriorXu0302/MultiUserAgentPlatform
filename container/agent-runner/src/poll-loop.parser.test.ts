import { describe, expect, it } from 'bun:test';

import { normalizeMessageBlocks } from './poll-loop.js';

describe('normalizeMessageBlocks (Bug-B)', () => {
  it('rewrites leading-slash typo `/message to=` to `<message to=`', () => {
    const input = '/message to="x">hello</message>';
    expect(normalizeMessageBlocks(input)).toBe('<message to="x">hello</message>');
  });

  it('rewrites leading-slash typo after a newline', () => {
    const input = 'preamble\n/message to="x">body</message>';
    expect(normalizeMessageBlocks(input)).toBe('preamble\n<message to="x">body</message>');
  });

  it('collapses stray space inside `< message` opening tag', () => {
    const input = '< message to="x">body</message>';
    expect(normalizeMessageBlocks(input)).toBe('<message to="x">body</message>');
  });

  it('passes well-formed input through unchanged', () => {
    const input = '<message to="x">body</message>';
    expect(normalizeMessageBlocks(input)).toBe(input);
  });

  it('normalizes a sloppy closing tag with internal spaces', () => {
    const input = '<message to="x">body< / message>';
    expect(normalizeMessageBlocks(input)).toBe('<message to="x">body</message>');
  });

  it('does not rewrite `/messageNotATag` (no `to=` follow-up)', () => {
    const input = 'See /messageInfo for details.';
    expect(normalizeMessageBlocks(input)).toBe('See /messageInfo for details.');
  });

  it('handles multiple typo forms in one payload', () => {
    const input = '/message to="a">first</message>\n< message to="b">second< / message>';
    expect(normalizeMessageBlocks(input)).toBe('<message to="a">first</message>\n<message to="b">second</message>');
  });
});
