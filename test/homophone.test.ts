import * as assert from 'assert';
import { harperGrammar, harperLoadError } from '../src/features/spellcheck/harperGrammar';

/**
 * Regression guard for the "their → they're" false positive.
 *
 * Background: a popup once flagged the correct possessive "their" in
 * "…we're their dirty little secret." and suggested "they're". That came from the
 * LLM proofread pass (now removed from grammar) — NOT from Harper, the deterministic
 * local grammar engine that owns grammar today. These tests lock in Harper's
 * behavior so the false positive can never return and so the WordChoice catches we
 * re-enabled (EXCLUDED_KINDS audit) keep working.
 *
 * PRECISION is the hard guarantee (the user's priority): correct prose must never be
 * flagged. RECALL covers the errors Harper actually supports — see KNOWN_MISSES for
 * the common ones it does not (deliberately not asserted, so a future Harper upgrade
 * that fixes them won't break this suite).
 */

// Correct prose — every one must come back with ZERO findings. Verified against
// Harper v2.4.0; includes idiom/preposition-heavy sentences (WordChoice territory).
const PRECISION = [
  "We're their dirty little secret.",
  "Their dirty little secret was safe with us.",
  'It is their house, and they love it.',
  'The cat licked its paw and yawned.',
  "You're welcome to stay as long as you like.",
  "They're going to regret this someday.",
  'She put the book back in its place.',
  'I have too many things to do today.',
  'He walked to the store to buy bread.',
  'Whose coat is this on the chair?',
  'The weather was worse than we feared.',
  'Your courage is the only thing keeping us alive.',
  'There are three reasons this will fail.',
  "We gave them what they needed but didn't want to see.",
  'He was more careful than his brother.',
  'She was taller than her mother by an inch.',
  'He did everything by the book, even when it cost him.',
  "I'm fed up with your excuses.",
  'We were fascinated by the old machine.',
  'She waved goodbye over his head and was gone.',
  'Their plan, whatever it was, had failed.',
  "You're not the person I thought you were."
];

// Real errors Harper catches (each yields ≥1 finding). "I want to go too the store"
// is the to/too WordChoice catch recovered by the EXCLUDED_KINDS audit.
const RECALL = [
  'Its a beautiful day.',
  'Your the best friend I have.',
  'I want to go too the store.',
  'We should of left earlier.'
];

// Common homophone errors Harper v2.4.0 does NOT catch. Documented for visibility;
// intentionally not asserted (a Harper upgrade may start catching them).
const KNOWN_MISSES = [
  'Their happy to see us.',
  'Its raining outside today.',
  'Your welcome to stay.',
  "They're car is bright red.",
  'There going home early.',
  'I have to many problems.'
];

describe('Harper grammar — homophone precision/recall', function () {
  this.timeout(20000);

  before(async () => {
    // Warm up and confirm Harper actually loaded here — otherwise it returns []
    // for everything and precision would pass vacuously. Make that an explicit,
    // readable failure instead of a silent green.
    const probe = await harperGrammar('We should of left earlier.');
    if (harperLoadError()) {
      throw new Error(`Harper failed to load in this environment: ${harperLoadError()}`);
    }
    assert.ok(probe.length > 0, 'Harper loaded but caught nothing on a known error — environment issue');
  });

  describe('precision: correct prose is never flagged', () => {
    for (const text of PRECISION) {
      it(`leaves clean: ${text}`, async () => {
        const found = await harperGrammar(text);
        assert.deepStrictEqual(found, [], `false positive on correct prose: ${JSON.stringify(found)}`);
      });
    }
  });

  describe('recall: supported errors are caught', () => {
    for (const text of RECALL) {
      it(`flags: ${text}`, async () => {
        const found = await harperGrammar(text);
        assert.ok(found.length > 0, `expected a finding for ${JSON.stringify(text)}`);
      });
    }
  });

  it('the screenshot case: never flags possessive "their" before a noun phrase', async () => {
    const found = await harperGrammar("In exchange, we're their dirty little secret.");
    assert.deepStrictEqual(found, [], `regressed — flagged correct "their": ${JSON.stringify(found)}`);
  });

  it('documents known misses without asserting them (informational)', () => {
    assert.ok(KNOWN_MISSES.length > 0);
  });
});
