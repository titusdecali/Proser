import * as assert from 'assert';
import { harperGrammar, harperLoadError } from '../src/features/spellcheck/harperGrammar';

/**
 * Regression guard for the fiction-prose opt-outs in harperGrammar(): Harper rules
 * that misfire on intentional creative writing and were suppressed at the author's
 * request (verified against harper.js v2.4.0). Two mechanisms:
 *
 *   - Native rule config (FICTION_RULE_CONFIG via setLintConfigWithJSON): ellipsis
 *     (EllipsisLength/UseEllipsisCharacter), profanity (AvoidCurses), a/an (AnA),
 *     unterminated-quote (UnclosedQuotes), let's (LetsConfusion).
 *   - Whole-kind exclusion (EXCLUDED_KINDS): the `Typo` kind — Harper's "split an unknown
 *     word" heuristic, which misfires on closed compounds ("streetwear" → "street wear")
 *     and dropped-g dialect ("lookin'" → "loo kin").
 *
 * SUPPRESSED sentences contain ONLY the opted-out nag, so they must come back empty.
 * KEPT sentences prove we did not over-suppress: a genuine merged-word typo ("alot",
 * which is a BoundaryError, not a Typo) and a to/too homophone must still be caught.
 */

// Each contains only a suppressed nag → must yield ZERO findings.
const SUPPRESSED = [
  'He paused... then left.', // ellipsis (Formatting)
  'She liked the streetwear best.', // closed compound (Typo)
  "Things are lookin' up now.", // dropped-g, straight apostrophe (Typo)
  'Things are lookin’ up now.', // dropped-g, curly apostrophe (Typo)
  'I’m just goin’ home, nothin’ doin’.', // multiple dropped-g (Typo)
  'His own ass nearly fell off.', // offensive language (WordChoice)
  // PronounContraction: pushed ordinary past-tense "were" to "we're"
  'Sixty, seventy people stood on the floor in their exotic fabrics, perfectly still, heads tilted ' +
    'at the same slight angle people used when they were reading their lens instead of the room.',
  // MassNouns: fiction nominalizes freely — "a burning" is intentional
  'Alix felt a burning on her back as she walked to the shed.',
  // MissingTo: mis-parsed the participial adjective "intended" as a verb needing "to"
  'Whatever their intended use, they floated Gary over the pit.',
  // PossessiveYour: pushed the subject "you two" to "your two"
  "If you two don't hurry, you'll regret it."
];

// Must STILL be caught after the opt-outs (guards against over-suppression).
const KEPT = [
  'I have alot of work.', // BoundaryError "a lot" — not a Typo, no apostrophe
  'I want to go too the store.' // to/too homophone (WordChoice, kept)
];

describe('Harper grammar — fiction-prose opt-outs', function () {
  this.timeout(20000);

  before(async () => {
    // Confirm Harper actually loaded here — otherwise it returns [] for everything and
    // the SUPPRESSED assertions would pass vacuously. Fail loudly instead.
    const probe = await harperGrammar('I want to go too the store.');
    if (harperLoadError()) {
      throw new Error(`Harper failed to load in this environment: ${harperLoadError()}`);
    }
    assert.ok(probe.length > 0, 'Harper loaded but caught nothing on a known error — environment issue');
  });

  describe('suppressed: opted-out nags never surface', () => {
    for (const text of SUPPRESSED) {
      it(`leaves clean: ${text}`, async () => {
        const found = await harperGrammar(text);
        assert.deepStrictEqual(found, [], `expected suppression, got: ${JSON.stringify(found)}`);
      });
    }
  });

  describe('kept: real errors are still caught', () => {
    for (const text of KEPT) {
      it(`flags: ${text}`, async () => {
        const found = await harperGrammar(text);
        assert.ok(found.length > 0, `over-suppressed — expected a finding for ${JSON.stringify(text)}`);
      });
    }
  });
});
