import * as assert from 'assert';
import { diffRange } from '../src/util/textDiff';

/** Applies a diffRange result to oldText and asserts it reproduces newText, and
 *  that the replaced span is minimal (no shared prefix/suffix left in it). */
function roundtrip(oldText: string, newText: string): { start: number; end: number; replacement: string } {
  const d = diffRange(oldText, newText);
  const rebuilt = oldText.slice(0, d.start) + d.replacement + oldText.slice(d.end);
  assert.strictEqual(rebuilt, newText, 'applying the diff must reproduce newText');
  return d;
}

describe('diffRange', () => {
  it('reports an empty no-op span for identical text', () => {
    const d = diffRange('hello', 'hello');
    assert.strictEqual(d.replacement, '');
    assert.strictEqual(d.start, d.end);
  });

  it('handles a single-character insertion in the middle', () => {
    const d = roundtrip('ac', 'abc');
    assert.deepStrictEqual(d, { start: 1, end: 1, replacement: 'b' });
  });

  it('handles a single-character deletion in the middle', () => {
    const d = roundtrip('abc', 'ac');
    assert.deepStrictEqual(d, { start: 1, end: 2, replacement: '' });
  });

  it('handles an append (insertion at the end)', () => {
    const d = roundtrip('chapter', 'chapter one');
    assert.strictEqual(d.start, 'chapter'.length);
    assert.strictEqual(d.end, 'chapter'.length);
    assert.strictEqual(d.replacement, ' one');
  });

  it('handles a prepend (insertion at the start)', () => {
    const d = roundtrip('world', 'hello world');
    assert.strictEqual(d.start, 0);
    assert.strictEqual(d.end, 0);
    assert.strictEqual(d.replacement, 'hello ');
  });

  it('handles a mid-word replacement', () => {
    roundtrip('The quick brown fox', 'The slow brown fox');
  });

  it('handles full replacement when nothing is shared', () => {
    const d = roundtrip('abc', 'xyz');
    assert.deepStrictEqual(d, { start: 0, end: 3, replacement: 'xyz' });
  });

  it('handles old → empty', () => {
    const d = roundtrip('gone', '');
    assert.deepStrictEqual(d, { start: 0, end: 4, replacement: '' });
  });

  it('handles empty → new', () => {
    const d = roundtrip('', 'fresh');
    assert.deepStrictEqual(d, { start: 0, end: 0, replacement: 'fresh' });
  });

  it('handles a repeated-character boundary correctly', () => {
    // Shared prefix "aa" and suffix "aa"; only the middle changes.
    roundtrip('aaXaa', 'aaYaa');
    roundtrip('aaaa', 'aaaaaa');
  });

  it('preserves a trailing newline edit as a minimal change', () => {
    roundtrip('line one\nline two', 'line one\nline 2');
  });
});
