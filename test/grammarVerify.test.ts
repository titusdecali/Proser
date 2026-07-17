import * as assert from 'assert';
import {
  GrammarVerifier,
  EnrichedIssue,
  enrichIssues,
  sentenceContext,
  buildVerifyPrompt,
  parseVerdicts,
  MAX_PER_CALL
} from '../src/features/spellcheck/grammarVerify';

/**
 * Regression guard for the AI grammar-verification layer: Harper's judgment-call
 * findings (WordChoice etc.) are HELD until the local model reviews them in
 * sentence context; mechanical findings surface immediately. Verdicts are cached
 * per containing sentence, kept findings stay visible while an edited sentence
 * re-verifies (no blink), and a failed model call fails OPEN (display unverified,
 * retry later) so a wedged model can never silently suppress real errors.
 */

function fakeClient(script: Array<(user: string) => string>): {
  client: never;
  calls: string[];
} {
  let call = 0;
  const calls: string[] = [];
  const client = {
    label: 'fake',
    chat: async (msgs: Array<{ role: string; content: string }>, onToken: (t: string) => void) => {
      const user = msgs[msgs.length - 1].content;
      calls.push(user);
      const fn = script[Math.min(call, script.length - 1)];
      call++;
      const text = fn(user);
      if (text === 'THROW') {
        throw new Error('model down');
      }
      onToken(text);
      return text;
    }
  } as never;
  return { client, calls };
}

const allReal = (real: boolean) => (user: string) => {
  const n = (user.match(/^\d+\. /gm) ?? []).length;
  return JSON.stringify({
    verdicts: Array.from({ length: n }, (_, i) => ({ id: i + 1, real, reason: 'test' }))
  });
};

const signal = new AbortController().signal;

const DOC =
  'The man stepped aside. "If you two don\'t hurry, you\'ll regret it." A pause followed.\n\n' +
  'Elsewhere the eelan hummed. Nobody noticed the sound at all.';
const START = DOC.indexOf('If you');
const ISSUE = {
  phrase: 'If you',
  message: 'The possessive version of this word is more common in this context.',
  fix: 'If your',
  kind: 'WordChoice',
  start: START,
  end: START + 6
};
const MECH = { phrase: 'the the', message: 'repeated', fix: 'the', kind: 'Repetition', start: 0, end: 7 };

describe('grammarVerify — context extraction and keys', () => {
  it('extracts the containing sentence and a ±1-sentence window', () => {
    const sc = sentenceContext(DOC, START, START + 6);
    assert.ok(sc.sentence.includes("If you two don't hurry"));
    const win = DOC.slice(sc.contextStart, sc.contextEnd);
    assert.ok(win.includes('stepped aside') && win.includes('A pause'), win);
  });

  it('splits mechanical from judgment-prone kinds and marks the span', () => {
    const [e1, e2] = enrichIssues(DOC, [ISSUE, MECH]);
    assert.strictEqual(e1.mechanical, false);
    assert.strictEqual(e2.mechanical, true);
    assert.ok(e1.context.includes('~If you~'));
  });

  it('keys on the containing sentence: stable across edits elsewhere, fresh on sentence edits', () => {
    const [e1] = enrichIssues(DOC, [ISSUE]);
    const elsewhere = DOC.replace('Nobody noticed', 'Nobody ever noticed');
    const [eElse] = enrichIssues(elsewhere, [
      { ...ISSUE, start: elsewhere.indexOf('If you'), end: elsewhere.indexOf('If you') + 6 }
    ]);
    assert.strictEqual(eElse.key, e1.key);
    const edited = DOC.replace("don't hurry", "don't hurry up");
    const [eSent] = enrichIssues(edited, [
      { ...ISSUE, start: edited.indexOf('If you'), end: edited.indexOf('If you') + 6 }
    ]);
    assert.notStrictEqual(eSent.key, e1.key);
  });
});

describe('grammarVerify — partition and verdict flow', function () {
  this.timeout(10000);
  const enriched = () => enrichIssues(DOC, [ISSUE, MECH]);

  it('verifying=false displays everything (no capable model → old behavior)', () => {
    const v = new GrammarVerifier();
    const { display, pending } = v.partition('d', enriched(), false);
    assert.strictEqual(display.length, 2);
    assert.strictEqual(pending.length, 0);
  });

  it('holds judgment-call findings, shows mechanical immediately', () => {
    const v = new GrammarVerifier();
    const { display, pending } = v.partition('d', enriched(), true);
    assert.strictEqual(display.length, 1);
    assert.strictEqual(pending.length, 1);
  });

  it('reject verdict removes the finding; keep verdict surfaces and caches it', async () => {
    const v = new GrammarVerifier();
    const issues = enriched();
    await v.verifyPending('d', v.partition('d', issues, true).pending, fakeClient([allReal(false)]).client, signal);
    const rejected = v.partition('d', issues, true);
    assert.strictEqual(rejected.display.length, 1); // mechanical only
    assert.strictEqual(rejected.pending.length, 0);

    const v2 = new GrammarVerifier();
    await v2.verifyPending('d', v2.partition('d', issues, true).pending, fakeClient([allReal(true)]).client, signal);
    const kept = v2.partition('d', issues, true);
    assert.strictEqual(kept.display.length, 2);
    assert.strictEqual(kept.pending.length, 0);
  });

  it('a previously-kept finding stays visible while its edited sentence re-verifies', async () => {
    const v = new GrammarVerifier();
    const [e1] = enrichIssues(DOC, [ISSUE]);
    await v.verifyPending('d', [e1], fakeClient([allReal(true)]).client, signal);
    const edited = DOC.replace("don't hurry", "don't hurry up");
    const [eSent] = enrichIssues(edited, [
      { ...ISSUE, start: edited.indexOf('If you'), end: edited.indexOf('If you') + 6 }
    ]);
    const { display, pending } = v.partition('d', [eSent], true);
    assert.strictEqual(display.length, 1, 'no shown→held blink');
    assert.strictEqual(pending.length, 1, 'still re-verifies');
  });

  it('fails OPEN on garbage or a model error, and a later real verdict overrides', async () => {
    const v = new GrammarVerifier();
    const [e1] = enrichIssues(DOC, [ISSUE]);
    await v.verifyPending('d', [e1], fakeClient([() => 'not json']).client, signal);
    const open = v.partition('d', [e1], true);
    assert.strictEqual(open.display.length, 1, 'displays unverified');
    assert.strictEqual(open.pending.length, 1, 'still retried');
    await v.verifyPending('d', open.pending, fakeClient([allReal(false)]).client, signal);
    assert.strictEqual(v.partition('d', [e1], true).display.length, 0, 'reject wins');

    const v2 = new GrammarVerifier();
    await v2.verifyPending('d', [e1], fakeClient([() => 'THROW']).client, signal);
    assert.strictEqual(v2.partition('d', [e1], true).display.length, 1);
  });

  it('chunks large batches and leaves unanswered ids pending', async () => {
    const many: EnrichedIssue[] = Array.from({ length: 30 }, (_, i) =>
      enrichIssues(`Sentence number ${i} has the word blorp in it.`, [
        { phrase: `blorp${i}`, message: 'm', fix: `blorp${i}x`, kind: 'WordChoice', start: 0, end: 5 }
      ])[0]
    );
    const v = new GrammarVerifier();
    const { client, calls } = fakeClient([allReal(true)]);
    await v.verifyPending('d', many, client, signal);
    assert.strictEqual(calls.length, Math.ceil(30 / MAX_PER_CALL));
    assert.strictEqual(v.partition('d', many, true).pending.length, 0);

    const v2 = new GrammarVerifier();
    const [e1] = enrichIssues(DOC, [ISSUE]);
    const other = enrichIssues('The scouts said they were close now.', [
      { phrase: 'they were', message: 'contraction?', fix: "they we're", kind: 'WordChoice', start: 16, end: 25 }
    ])[0];
    const partial = fakeClient([() => JSON.stringify({ verdicts: [{ id: 1, real: true, reason: 'r' }] })]);
    await v2.verifyPending('d', [e1, other], partial.client, signal);
    const after = v2.partition('d', [e1, other], true);
    assert.strictEqual(after.display.length, 1);
    assert.strictEqual(after.pending.length, 1);
  });

  it('parseVerdicts: null on garbage, drops unasked ids; prompt carries context', () => {
    assert.strictEqual(parseVerdicts('nope', [1]), null);
    const noisy = parseVerdicts(JSON.stringify({ verdicts: [{ id: 9, real: true, reason: 'x' }] }), [1]);
    assert.strictEqual(noisy!.size, 0);
    const [e1] = enrichIssues(DOC, [ISSUE]);
    const prompt = buildVerifyPrompt([e1]);
    assert.ok(prompt.user.includes('~If you~') && prompt.user.includes('possessive'));
  });

  it('dispose drops verdicts and sticky keeps', async () => {
    const v = new GrammarVerifier();
    const [e1] = enrichIssues(DOC, [ISSUE]);
    await v.verifyPending('d', [e1], fakeClient([allReal(true)]).client, signal);
    v.dispose('d');
    const { display, pending } = v.partition('d', [e1], true);
    assert.strictEqual(display.length, 0);
    assert.strictEqual(pending.length, 1);
  });
});
