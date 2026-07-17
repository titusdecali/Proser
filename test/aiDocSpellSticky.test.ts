import * as assert from 'assert';
import { AiDocSpellChecker, DocSpellResult } from '../src/features/spellcheck/aiDocSpell';

/**
 * Regression guard for the spell-squiggle "waves" (mark → clear → mark on unchanged
 * words): editing a paragraph resets it to an unchecked placeholder, and the checker
 * emits an aggregate immediately — that aggregate used to DROP the paragraph's
 * previously cleared (intentional) words, re-squiggling them until the model
 * re-confirmed seconds later. Clearances are now sticky per document: they survive
 * paragraph edits and dictionary-change cache resets (keepCleared), and are only
 * overridden when a word currently has a genuine correction (typo wins).
 */

function fakeEngine(
  verdicts: Record<string, { misspelling: boolean; corrections?: string[] }>,
  delayMs = 0
): never {
  return {
    label: 'fake',
    chat: async (_msgs: unknown, onToken: (t: string) => void) => {
      if (delayMs) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
      const words = Object.entries(verdicts).map(([word, v]) => ({
        word,
        misspelling: v.misspelling,
        corrections: v.corrections ?? []
      }));
      const text = JSON.stringify({ words });
      onToken(text);
      return text;
    }
  } as never;
}

const hooks = {
  findMisspellings: async (text: string) =>
    /\beelan\b/i.test(text) ? [{ word: 'eelan', suggestions: ['elan'] }] : [],
  isValidWord: async () => true
};

const signal = new AbortController().signal;

async function run(checker: AiDocSpellChecker, text: string, engine: never): Promise<DocSpellResult[]> {
  const emitted: DocSpellResult[] = [];
  await checker.update(
    'doc',
    text,
    engine,
    hooks,
    true,
    (r) => emitted.push({ suggestions: new Map(r.suggestions), cleared: new Set(r.cleared) }),
    signal
  );
  return emitted;
}

describe('AiDocSpellChecker — sticky clearances (squiggle-wave fix)', function () {
  this.timeout(10000);

  it('keeps a cleared word cleared across a paragraph edit, even in the immediate aggregate', async () => {
    const checker = new AiDocSpellChecker();
    const v1 = await run(checker, 'Alix felt the eelan hum.', fakeEngine({ eelan: { misspelling: false } }));
    assert.ok(v1[v1.length - 1].cleared.has('eelan'), 'model clearance recorded');

    // Edited paragraph → new hash → unchecked placeholder. The FIRST aggregate
    // (before the delayed model answers) must still carry the clearance.
    const v2 = await run(
      checker,
      'Alix felt the eelan hum loudly.',
      fakeEngine({ eelan: { misspelling: false } }, 80)
    );
    assert.ok(v2[0].cleared.has('eelan'), 'immediate aggregate kept the clearance (was the flicker bug)');
    assert.ok(v2[v2.length - 1].cleared.has('eelan'), 'final aggregate still cleared');
  });

  it('never suppresses a word that currently has a genuine correction (typo wins)', async () => {
    const checker = new AiDocSpellChecker();
    await run(checker, 'Alix felt the eelan hum.', fakeEngine({ eelan: { misspelling: false } }));
    const v = await run(
      checker,
      'Alix felt the eelan hum darkly.',
      fakeEngine({ eelan: { misspelling: true, corrections: ['elan'] } })
    );
    const final = v[v.length - 1];
    assert.strictEqual(final.cleared.has('eelan'), false, 'sticky clearance must yield to a correction');
    assert.ok((final.suggestions.get('eelan') ?? []).length > 0, 'the correction surfaces');
  });

  it('keepCleared preserves verdicts across a dictionary-change cache reset; a full dispose drops them', async () => {
    const checker = new AiDocSpellChecker();
    await run(checker, 'Alix felt the eelan hum.', fakeEngine({ eelan: { misspelling: false } }));

    checker.dispose('doc', { keepCleared: true });
    const kept = await run(
      checker,
      'Alix felt the eelan hum again.',
      fakeEngine({ eelan: { misspelling: false } }, 80)
    );
    assert.ok(kept[0].cleared.has('eelan'), 'clearance survived the dictionary-change reset');

    checker.dispose('doc');
    const dropped = await run(
      checker,
      'Alix felt the eelan hum anew.',
      fakeEngine({ eelan: { misspelling: false } }, 80)
    );
    assert.strictEqual(dropped[0].cleared.has('eelan'), false, 'full dispose starts from scratch');
    assert.ok(dropped[dropped.length - 1].cleared.has('eelan'), 'model re-clears in the final aggregate');
  });
});
