/** Whole-document AI tense pass for the live editor underline. Unlike spelling/
 *  grammar (per-paragraph), tense needs the WHOLE doc: the model infers the
 *  dominant narrative tense, then flags sentences that slip out of it. The caller
 *  (ProserEditorProvider) throttles, caches, and gates this — here we just run one
 *  analysis and return the offending sentences for the webview to underline. */
import { AiClient } from '../ai/AiClient';
import { ProofreadFinding, ProofreadPass, proofreadDocument } from './proofreadPass';
import { TenseOverride } from '../../util/proserMeta';

/** A tense-inconsistency finding to underline (its own color). Structurally a
 *  {@link ProofreadFinding}: `phrase` is the verbatim sentence so the webview can
 *  anchor the squiggle by string match; `fix` is the corrected-tense rewrite. */
export type TenseFinding = ProofreadFinding;

const SYSTEM =
  'You are a copy-editor checking NARRATIVE TENSE CONSISTENCY in fiction prose. JSON only.';

function buildUser(body: string, targetTense?: TenseOverride): string {
  // When the chapter pins a tense (per-chapter override), skip auto-detection and
  // hold the prose to THAT tense; otherwise infer the dominant tense from the prose.
  const head = targetTense
    ? `This chapter's narrative tense is ${targetTense.toUpperCase()}. Flag every NARRATION ` +
      `sentence whose main verb is NOT in the ${targetTense} tense (ignore dialogue inside quotes). ` +
      'These are real slips out of the chosen tense.\n'
    : 'Step 1: read the prose below and decide its DOMINANT narrative tense — past or present — ' +
      'from the majority of the NARRATION verbs (ignore dialogue inside quotes).\n' +
      'Step 2: flag every NARRATION sentence whose main verb is in the OTHER tense. These are real ' +
      'slips the author missed.\n';
  return (
    head +
    'Example — if the narration is PAST tense:\n' +
    '  "She thumbed her ring and the bike waited." → fine (past).\n' +
    '  "She likes to go there often." → SLIP (present "likes" in past narration) → ' +
    'suggestion "She liked to go there often."\n' +
    'Do NOT flag: dialogue inside quotation marks, or a passage clearly set in another time on purpose. ' +
    'When unsure, leave it out.\n' +
    'Include a sentence ONLY if your "suggestion" is genuinely DIFFERENT from the original — NEVER include ' +
    'a sentence that is already correct, and never repeat the sentence unchanged as the suggestion.\n' +
    'Change ONLY the verb TENSE. Keep wording, contractions, and punctuation otherwise IDENTICAL — NEVER ' +
    'expand a contraction (she\'d, don\'t, it\'s), NEVER change formality, and NEVER reword. If the only ' +
    'change you would make is expanding a contraction or rewording, do NOT include the sentence.\n' +
    'Return STRICT JSON only — no prose, no code fences — of this shape:\n' +
    '{"issues":[{"sentence":"<the offending sentence copied EXACTLY from the text>",' +
    '"suggestion":"<that sentence rewritten in the dominant tense>","reason":"<short why>"}]}\n' +
    'Copy "sentence" byte-for-byte so it can be located. Max 40 issues. Empty "issues" if there are none.\n\n---\n' +
    body
  );
}

/** A tense "signature" for comparing a sentence to its suggestion. Contractions and
 *  their expansions collapse to the same form ('d / would / had → one token, n't →
 *  not, 're → are …) and punctuation/case are stripped, so a suggestion that only
 *  EXPANDS a contraction (she'd → she had) or re-punctuates compares EQUAL to the
 *  original — i.e. it isn't a real tense change. A genuine tense edit (likes → liked,
 *  has → had, don't → didn't) changes a verb the signature keeps, so it stays different. */
function tenseSig(s: string): string {
  return s
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/n't\b/g, ' not')
    .replace(/\b(\w+)'re\b/g, '$1 are')
    .replace(/\b(\w+)'ve\b/g, '$1 have')
    .replace(/\b(\w+)'ll\b/g, '$1 will')
    .replace(/\b(\w+)'m\b/g, '$1 am')
    .replace(/\b(\w+)'s\b/g, '$1 is')
    .replace(/\b(\w+)'d\b/g, '$1 _md_')
    .replace(/\b(?:would|had)\b/g, '_md_')
    .replace(/[^a-z0-9_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when the model's "reason" describes a NON-tense edit (contraction, formality,
 *  rewording, punctuation) OR a SUBJECTIVE/stylistic rewrite ("the original is weak",
 *  "reinforces", "more vivid", …) rather than an actual tense slip. A real tense fix
 *  only swaps verb forms; anything the model justifies on style is not ours to flag. */
function nonTenseReason(reason: string): boolean {
  return /contraction|formal|word.?choice|rephras|reword|punctuat|capitaliz|weak|stronger|strengthen|reinforc|emphasi|vivid|flow|smooth|concise|awkward|improv|better|enhanc|stylist|tighten|punch|clarit|clearer|elegan|rhythm/i.test(
    reason
  );
}

/** Removes DOUBLE-quoted spans (dialogue) so a sentence can be judged on its NARRATION
 *  alone. Characters speak in any tense, so a "slip" that lives entirely inside quotation
 *  marks is not a narration error — the book's past tense does not bind dialogue. Only
 *  double quotes (straight or curly) are stripped; single quotes double as apostrophes
 *  (don't, it's), so stripping them would mangle contractions. */
function stripDialogue(s: string): string {
  return s.replace(/[“"][^“”"]*[”"]/gu, ' ');
}

/** True when `phrase` sits inside a double-quoted span (dialogue) in the FULL document.
 *  The per-sentence {@link stripDialogue} can't catch this when a quote runs across several
 *  sentences (a long speech): each inner sentence carries no quote mark of its own, so it
 *  looks like narration. Here we locate the sentence and count the double-quotes before it
 *  WITHIN ITS PARAGRAPH — an odd count means an opening quote is still unclosed, i.e. we're
 *  inside dialogue. Quote-style agnostic ("…" or “…”); single quotes/apostrophes are ignored
 *  so contractions (don't, they're) never miscount. A sentence we can't locate is treated as
 *  narration (kept) — the webview's own string-anchor would drop an unlocatable phrase anyway. */
export function phraseInDialogue(text: string, phrase: string): boolean {
  const idx = text.indexOf(phrase);
  if (idx < 0) {
    return false;
  }
  const nn = text.lastIndexOf('\n\n', idx);
  const paraStart = nn < 0 ? 0 : nn + 2;
  const quotesBefore = (text.slice(paraStart, idx).match(/["“”]/g) || []).length;
  return quotesBefore % 2 === 1;
}

/** The tense pass: drops findings that aren't genuine tense slips — a suggestion that
 *  only expands a contraction / re-punctuates (she'd → she had) compares EQUAL under
 *  tenseSig, reasons about contractions / formality / wording aren't slips, and a change
 *  confined to DIALOGUE (the narration outside the quotes is unchanged) is exempt because
 *  speech isn't bound to the book's narrative tense. */
const tenseAccept: ProofreadPass['accept'] = ({ phrase, fix, reason }) => {
  const sp = tenseSig(phrase);
  const sf = tenseSig(fix);
  return (
    sp !== sf &&
    !nonTenseReason(reason) &&
    tenseSig(stripDialogue(phrase)) !== tenseSig(stripDialogue(fix)) &&
    // A genuine tense slip is a 1:1 verb-form swap (likes→liked, is→was), so the
    // normalized word counts must match. This rejects the model's stylistic rewrites
    // that ADD or DROP words — e.g. "…at Blueprint." → "…at Blueprint did he think."
    sp.split(' ').length === sf.split(' ').length
  );
};

/** Runs the tense analysis over the whole document. With `targetTense` the chapter's
 *  tense is held to that value (per-chapter override); without it the dominant tense
 *  is auto-detected (the global default). Resolves to the deviating sentences
 *  (deduped), [] when there are none, or null when EVERY window returned unparseable
 *  output (caller keeps the prior squiggles). */
export async function proofreadTense(
  client: AiClient,
  text: string,
  targetTense?: TenseOverride | null,
  signal?: AbortSignal
): Promise<TenseFinding[] | null> {
  const pass: ProofreadPass = {
    system: SYSTEM,
    buildUser: (body) => buildUser(body, targetTense ?? undefined),
    defaultMessage: 'Tense inconsistency',
    accept: tenseAccept
  };
  const findings = await proofreadDocument(client, text, pass, signal);
  if (!findings) {
    return null;
  }
  // Document-level dialogue exemption: a past-tense story's dialogue is naturally in other
  // tenses, so speech is never a narration slip. The per-sentence stripDialogue in `accept`
  // misses sentences inside a MULTI-sentence quote (a long speech) — those carry no quote of
  // their own — so drop any finding whose sentence sits inside an open quote here.
  return findings.filter((f) => !phraseInDialogue(text, f.phrase));
}
