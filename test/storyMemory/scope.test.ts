/**
 * Unit tests for the pure `chapterId` slug helper (docs/STORY-MEMORY-SPEC.md §6:
 * content-stable, token-safe ids). Only this exported helper is exercised — the
 * rest of scope.ts needs vscode.workspace and is out of scope for unit tests.
 */
import * as assert from 'assert';
import { chapterId } from '../../src/features/storyMemory/scope';

describe('chapterId — slug stability', () => {
  it('strips the .md extension (case-insensitive) and lowercases', () => {
    assert.strictEqual(chapterId('01-blueprint.md'), '01-blueprint');
    assert.strictEqual(chapterId('01-blueprint.MD'), '01-blueprint');
    assert.strictEqual(chapterId('01-Blueprint.md'), '01-blueprint');
  });

  it('encodes path separators as "__" so nested files do not alias flat ones', () => {
    assert.strictEqual(chapterId('sub/01-blueprint.md'), 'sub__01-blueprint');
    assert.strictEqual(chapterId('sub/sub2/x.md'), 'sub__sub2__x');
  });

  it('keeps dots, underscores and hyphens as token-safe chars', () => {
    assert.strictEqual(chapterId('A_B.md'), 'a_b');
    assert.strictEqual(chapterId('1.2.3.md'), '1.2.3');
  });

  it('replaces runs of unsafe chars (incl. spaces) with a single hyphen', () => {
    assert.strictEqual(chapterId('A B.md'), 'a-b');
    assert.strictEqual(chapterId('Chapter 1: The Beginning.md'), 'chapter-1-the-beginning');
  });

  it('trims leading/trailing hyphens', () => {
    assert.strictEqual(chapterId('--weird--.md'), 'weird');
  });

  it('is idempotent on an already-slugged value', () => {
    const once = chapterId('01-blueprint.md');
    assert.strictEqual(chapterId(once + '.md'), once);
    assert.strictEqual(chapterId(once), once);
  });
});

describe('chapterId — path separators avoid the obvious collision', () => {
  it('distinguishes "sub/x" from a flat "sub-x"', () => {
    // The "/"→"__" mapping happens AFTER unsafe chars become "-", so a real
    // subfolder ("sub__x") never collides with a flattened name ("sub-x").
    assert.notStrictEqual(chapterId('sub/x.md'), chapterId('sub-x.md'));
    assert.strictEqual(chapterId('sub/x.md'), 'sub__x');
    assert.strictEqual(chapterId('sub-x.md'), 'sub-x');
  });
});

describe('chapterId — documented (acceptable) collisions', () => {
  it('collapses space vs hyphen into the same slug', () => {
    // Both a space and a literal hyphen normalize to "-", so "A B" and "A-B"
    // intentionally share one id. This is an accepted lossy-slug property: distinct
    // source filenames can map to the same chapterId. Documented, not a bug.
    assert.strictEqual(chapterId('A B.md'), chapterId('A-B.md'));
  });

  it('drops non-ASCII characters (lossy but stable)', () => {
    // Non-[A-Za-z0-9._/-] runs collapse to "-", so accented letters are removed.
    assert.strictEqual(chapterId('déjà.md'), 'd-j');
  });
});
