/**
 * Unit tests for the pure parsing/coercion half of the extractor. Model output is
 * UNTRUSTED: `parseJson` must dig a JSON object out of a messy reply, and
 * `normalize` must coerce it into a safe ChapterMemory (per-chapter summary). No AI
 * calls, no live engine.
 */
import * as assert from 'assert';
import { parseJson, normalize, ExtractInput } from '../../src/features/storyMemory/extract';
import { hashContent } from '../../src/features/storyMemory/store';

const input: ExtractInput = { chapterId: 'c1', title: 'Chapter One', order: 3, text: 'hello world' };

describe('parseJson', () => {
  it('tolerates ```json fences', () => {
    assert.deepStrictEqual(parseJson('```json\n{"a":1}\n```'), { a: 1 });
  });

  it('tolerates preamble + trailing prose around the object', () => {
    assert.deepStrictEqual(parseJson('Sure! {"a":1}\n\nHope that helps!'), { a: 1 });
  });

  it('returns {} on garbage, empty input, or a top-level array', () => {
    assert.deepStrictEqual(parseJson('totally not json'), {});
    assert.deepStrictEqual(parseJson(''), {});
    assert.deepStrictEqual(parseJson('[1,2,3]'), {});
  });
});

describe('normalize — summary shape', () => {
  it('carries chapter metadata + content hash', () => {
    const n = normalize(input, {});
    assert.strictEqual(n.chapterId, 'c1');
    assert.strictEqual(n.title, 'Chapter One');
    assert.strictEqual(n.order, 3);
    assert.strictEqual(n.hash, hashContent('hello world'));
  });

  it('produces a fully empty-but-valid ChapterMemory from {}', () => {
    const n = normalize(input, {});
    assert.strictEqual(n.summary, '');
    assert.strictEqual(n.startLocation, '');
    assert.strictEqual(n.endLocation, '');
    assert.deepStrictEqual(n.plotPoints, []);
    assert.deepStrictEqual(n.characterArcs, []);
  });

  it('keeps string fields and trims them', () => {
    const n = normalize(input, {
      summary: '  Miles asks his father about fear; the car crashes.  ',
      startLocation: 'a moving car',
      endLocation: 'a foggy bridge'
    });
    assert.strictEqual(n.summary, 'Miles asks his father about fear; the car crashes.');
    assert.strictEqual(n.startLocation, 'a moving car');
    assert.strictEqual(n.endLocation, 'a foggy bridge');
  });

  it('coerces non-string scalar fields to empty strings', () => {
    const n = normalize(input, { summary: 42, startLocation: null, endLocation: {} });
    assert.strictEqual(n.summary, '');
    assert.strictEqual(n.startLocation, '');
    assert.strictEqual(n.endLocation, '');
  });

  it('keeps string arrays, drops blanks/non-strings, caps at 8', () => {
    const n = normalize(input, {
      plotPoints: ['a', '', '  ', 'b', 7, 'c'],
      characterArcs: Array.from({ length: 12 }, (_, i) => `arc ${i}`)
    });
    assert.deepStrictEqual(n.plotPoints, ['a', 'b', 'c']);
    assert.strictEqual(n.characterArcs.length, 8);
  });

  it('coerces non-array list fields to empty arrays', () => {
    const n = normalize(input, { plotPoints: 'nope', characterArcs: 42 });
    assert.deepStrictEqual(n.plotPoints, []);
    assert.deepStrictEqual(n.characterArcs, []);
  });
});
