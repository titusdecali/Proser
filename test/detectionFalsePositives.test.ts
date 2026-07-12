import * as assert from 'assert';
import { mapHarperLints } from '../src/features/spellcheck/harperGrammar';
import { tenseAccept } from '../src/features/spellcheck/aiTense';
import { noopReason, noopSuggestion } from '../src/features/spellcheck/proofreadPass';

/**
 * Regression guard for the detection false positives fixed after the screenshot report
 * (v1.4.43): a "(No change needed)" AI suggestion surfacing as a one-click fix, the
 * tense pass "correcting" a bare infinitive after a perception verb ("felt the pressure
 * build" → "built"), and Harper insert-after suggestions rendered as replacements
 * ("their intended" → "their to"). The rule-level Harper opt-outs (PronounContraction,
 * MassNouns, MissingTo) are covered end-to-end in harperFiction.test.ts.
 */

describe('no-op AI suggestions never surface as findings', () => {
  it('recognizes no-op suggestion sentinels', () => {
    for (const s of [
      '(No change needed)',
      'No change needed.',
      'no changes are necessary',
      'N/A',
      'Unchanged',
      'keep as is',
      'The sentence is fine as written'
    ]) {
      assert.strictEqual(noopSuggestion(s), true, `expected no-op: ${JSON.stringify(s)}`);
    }
  });

  it('never swallows a real rewrite that merely contains those words', () => {
    for (const s of [
      'No one changed the locks that night.',
      'He kept the original letter in the drawer.',
      'Nothing to change here, he thought.',
      'She was left unchanged by the news.'
    ]) {
      assert.strictEqual(noopSuggestion(s), false, `real rewrite rejected: ${JSON.stringify(s)}`);
    }
  });

  it('recognizes a reason that declares the sentence already fine', () => {
    // The exact reason from the screenshot report.
    assert.strictEqual(
      noopReason('The focus is on the action of setting something down, which is fine as written.'),
      true
    );
    assert.strictEqual(noopReason('No change is needed here.'), true);
  });

  it('keeps legitimate flag reasons', () => {
    for (const r of [
      'present "likes" in past narration',
      'Marcus is the vivid doer; active is tighter.',
      "the correct past form is 'walked'",
      // CONTRASTIVE reasons: no-op wording about one part, a real flag about another
      "The first clause is already correct, but 'walk' should be 'walked'.",
      "Only 'walk' needs fixing; the rest of the sentence is fine as written."
    ]) {
      assert.strictEqual(noopReason(r), false, `legit reason swallowed: ${JSON.stringify(r)}`);
    }
  });
});

describe('tense pass — bare infinitive after a perception verb is not a slip', () => {
  it('rejects the "felt the pressure build → built" false positive', () => {
    assert.strictEqual(
      tenseAccept({
        phrase: 'He felt the pressure of altitude build against his ears with each switchback turn.',
        fix: 'He felt the pressure of altitude built against his ears with each switchback turn.',
        reason: "The main verb 'felt' is past, but the construction suggests a continuous action."
      }),
      false
    );
  });

  it('rejects other perception-verb complements (heard/watched)', () => {
    assert.strictEqual(
      tenseAccept({
        phrase: 'They heard the door close behind them.',
        fix: 'They heard the door closed behind them.',
        reason: 'should match the past tense'
      }),
      false
    );
    assert.strictEqual(
      tenseAccept({
        phrase: 'She watched the light fade from the window.',
        fix: 'She watched the light faded from the window.',
        reason: 'should match the tense'
      }),
      false
    );
  });

  it('handles pronoun subjects, -ed base verbs, and contraction no-ops', () => {
    // "No one" is a pronoun subject — "saw" still governs the bare infinitive.
    assert.strictEqual(
      tenseAccept({
        phrase: 'No one saw the lights flicker in the tower.',
        fix: 'No one saw the lights flickered in the tower.',
        reason: 'should match the tense'
      }),
      false
    );
    // "embed" is a base verb, not a past form.
    assert.strictEqual(
      tenseAccept({
        phrase: 'He watched the blade embed itself in the wood.',
        fix: 'He watched the blade embedded itself in the wood.',
        reason: 'should match the tense'
      }),
      false
    );
    // The HAS reading of 's: expanding it is a no-op, not a tense fix.
    assert.strictEqual(
      tenseAccept({
        phrase: "She's walked there before.",
        fix: 'She has walked there before.',
        reason: 'expand for tense clarity'
      }),
      false
    );
  });

  it('covers bare infinitives ending in -eed and governors past a noun homograph', () => {
    // "bleed" must not be misread as a finite -ed past form.
    assert.strictEqual(
      tenseAccept({
        phrase: 'She watched the wound bleed through the bandage.',
        fix: 'She watched the wound bled through the bandage.',
        reason: 'should match the past tense'
      }),
      false
    );
    // "the watch" is a noun; the true governor "felt" sits further back.
    assert.strictEqual(
      tenseAccept({
        phrase: 'He felt the watch tick against his wrist.',
        fix: 'He felt the watch ticked against his wrist.',
        reason: 'should match the tense'
      }),
      false
    );
  });

  it('still keeps genuine tense slips', () => {
    const real = [
      // no perception verb involved
      { phrase: 'She likes to go there often.', fix: 'She liked to go there often.' },
      // the slip sits in a NEW clause after a conjunction
      { phrase: 'They felt tired and walk away.', fix: 'They felt tired and walked away.' },
      // "as" starts a finite clause
      { phrase: 'He watched as the crowd surge forward.', fix: 'He watched as the crowd surged forward.' },
      // the perception verb ITSELF is the slip
      { phrase: 'He feels the rope tighten.', fix: 'He felt the rope tighten.' },
      // zero-"that" complement clause — the changed word is an irregular FINITE form
      { phrase: 'He noticed the streets are empty.', fix: 'He noticed the streets were empty.' },
      { phrase: 'She saw they have gone.', fix: 'She saw they had gone.' },
      // perception-verb NOUN homographs ("a sense", "the watch") grant no exemption
      { phrase: 'A sense of dread grow inside her.', fix: 'A sense of dread grew inside her.' },
      { phrase: 'The watch glow in the dark.', fix: 'The watch glowed in the dark.' },
      // a subordinator starts a finite clause
      { phrase: 'He felt calmer though the pains linger.', fix: 'He felt calmer though the pains lingered.' },
      // modals are finite — "felt she can" is a that-clause, never a bare infinitive
      { phrase: 'She felt she can trust him.', fix: 'She felt she could trust him.' },
      // irregular past after a perception verb: present-tense narration slipping into past
      { phrase: 'She watches the sun rose over the hills.', fix: 'She watches the sun rise over the hills.' },
      // a real is→was slip expressed through a contraction still registers
      { phrase: "It's cold in here.", fix: 'It was cold in here.' }
    ];
    for (const c of real) {
      assert.strictEqual(
        tenseAccept({ ...c, reason: 'present in past narration' }),
        true,
        `real slip suppressed: ${c.phrase}`
      );
    }
  });
});

describe('Harper suggestion kinds map correctly', () => {
  const text = 'Whatever their intended use, they floated Gary over.';
  // "intended" = offsets 15..23.
  const stub = (kind: number, replacement: string) => ({
    span: () => ({ start: 15, end: 23 }),
    message: () => 'msg',
    lint_kind: () => 'WordChoice',
    suggestion_count: () => 1,
    suggestions: () => [{ kind: () => kind, get_replacement_text: () => replacement }]
  });

  it('insert-after (kind 2) keeps the flagged word and appends', () => {
    const issues = mapHarperLints(text, [stub(2, ' to')]);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].phrase, 'their intended');
    assert.strictEqual(issues[0].fix, 'their intended to');
  });

  it('replace (kind 0) still replaces the span', () => {
    const issues = mapHarperLints(text, [stub(0, 'settled')]);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].fix, 'their settled');
  });

  it('remove (kind 1) still deletes the span', () => {
    const issues = mapHarperLints(text, [stub(1, '')]);
    assert.strictEqual(issues.length, 1);
    assert.strictEqual(issues[0].fix, '');
  });
});
