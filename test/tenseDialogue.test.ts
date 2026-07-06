import * as assert from 'assert';
import { phraseInDialogue } from '../src/features/spellcheck/aiTense';

/**
 * Regression guard: the live tense underline must NOT flag dialogue. A past-tense
 * story's dialogue is naturally in other tenses, so quoted speech is never a narration
 * slip. The per-sentence stripDialogue missed sentences inside a MULTI-sentence quote
 * (a long speech) because each inner sentence carries no quote mark of its own — this is
 * the document-level check that fixes that (the "They seem to know…" screenshot case).
 */

// A flowing paragraph with interleaved narration + dialogue, as in the report.
const PARA =
  '"Near the end, some of them arrive at this... absolute peace. Not resignation—certainty. ' +
  "They seem to know where they're going. It's not that they're making peace with dying, but rather that " +
  'they\'re impatient to begin something new." A breath. "Some of them even see ahead."';

const CURLY = '“They seem to know where they’re going,” she said. He nodded slowly.';
const NARRATION = 'He walked to the window. The veil seemed to wear thin near the end.';
const DOC = [PARA, CURLY, NARRATION].join('\n\n');

describe('aiTense — dialogue is exempt from the tense check', () => {
  it('flags sentence INSIDE a multi-sentence quote as dialogue', () => {
    assert.strictEqual(phraseInDialogue(DOC, "They seem to know where they're going."), true);
  });

  it('treats the second quote in the same paragraph as dialogue', () => {
    assert.strictEqual(phraseInDialogue(DOC, 'Some of them even see ahead.'), true);
  });

  it('handles curly quotes', () => {
    assert.strictEqual(phraseInDialogue(DOC, 'They seem to know where they’re going,'), true);
  });

  it('does NOT treat interleaved narration as dialogue', () => {
    assert.strictEqual(phraseInDialogue(DOC, 'A breath.'), false);
    assert.strictEqual(phraseInDialogue(DOC, 'He nodded slowly.'), false);
  });

  it('does NOT treat a pure narration paragraph as dialogue', () => {
    assert.strictEqual(phraseInDialogue(DOC, 'The veil seemed to wear thin near the end.'), false);
  });

  it('keeps an unlocatable sentence (returns false → not suppressed here)', () => {
    assert.strictEqual(phraseInDialogue(DOC, 'A sentence that is not in the document.'), false);
  });
});
