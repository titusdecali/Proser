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
    'Flag ONLY the FINITE main verb — the one that carries the sentence\'s tense. NEVER flag an ' +
    '-ing form (present participle or gerund) or a "to"-infinitive: these are non-finite and are ' +
    'correct in BOTH past and present narration. In PAST narration "Aeons chiseled away, paving a road" ' +
    'is CORRECT — do NOT change "paving" to "paved"; "She turned, smiling" is CORRECT — do NOT change ' +
    '"smiling" to "smiled". Only a finite verb in the wrong tense (likes→liked, is→was) is a slip.\n' +
    'A BARE infinitive after a perception or causative verb (felt/saw/heard/watched/let/made/helped + ' +
    'object + verb) is also non-finite and CORRECT in past narration: "He felt the pressure build ' +
    'against his ears", "she watched the sun set", "they heard the door close" are all correct — the ' +
    'finite verb (felt/watched/heard) already carries the tense; do NOT change "build" to "built".\n' +
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
    .replace(/\b(\w+)'s\b/g, '$1 _s_')
    .replace(/\b(?:is|has)\b/g, '_s_')
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
  return /participl|gerund|infinitiv|non.?finite|contraction|formal|word.?choice|rephras|reword|punctuat|capitaliz|weak|stronger|strengthen|reinforc|emphasi|vivid|flow|smooth|concise|awkward|improv|better|enhanc|stylist|tighten|punch|clarit|clearer|elegan|rhythm/i.test(
    reason
  );
}

/** True when the suggestion's only change turns an -ing form into something else —
 *  i.e. the model "corrected" a PRESENT PARTICIPLE, gerund, or the verb of a
 *  participial phrase ("chiseled away, paving a road" → "…paved a road"; "she turned,
 *  smiling" → "…smiled"). An -ing verb is NON-FINITE: it carries no narrative tense and
 *  is perfectly grammatical inside past- OR present-tense prose, so changing it is a
 *  false positive, not a tense slip. Word counts already match at the call site, so we
 *  align the two token lists 1:1; if any word the model REPLACED ends in -ing, it was
 *  de-participling. A genuine progressive-tense slip changes the AUXILIARY ("is walking"
 *  → "was walking"), leaving the -ing word untouched, so this never rejects a real fix. */
function convertsParticiple(phrase: string, fix: string): boolean {
  const pw = tenseSig(phrase).split(' ');
  const fw = tenseSig(fix).split(' ');
  if (pw.length !== fw.length) {
    return false; // only meaningful for aligned 1:1 verb swaps
  }
  for (let i = 0; i < pw.length; i++) {
    if (pw[i] !== fw[i] && /ing$/.test(pw[i])) {
      return true; // a replaced word was an -ing form → participle/gerund, not a tense slip
    }
  }
  return false;
}

/** Perception / causative verbs that govern a BARE-infinitive complement ("felt the
 *  pressure build", "watched the sun set", "made him stop"). The bare verb after them is
 *  NON-FINITE — correct in past or present narration — so a "fix" that inflects it
 *  ("build" → "built") is a false positive, not a tense slip. (No "had": tenseSig
 *  rewrites it, so causative-have can't be matched here anyway.) */
const PERCEPTION_VERB_RE =
  /^(?:feel|feels|felt|see|sees|saw|seen|watch|watches|watched|hear|hears|heard|notice|notices|noticed|observe|observes|observed|sense|senses|sensed|let|lets|make|makes|made|help|helps|helped)$/;

/** Words that start a NEW clause between a perception verb and a later verb — past one
 *  of these, that later verb is finite again ("felt cold and walks away" IS a real slip;
 *  "watched as the crowd surge forward" is too). tenseSig strips punctuation, so these
 *  conjunctions/subordinators are the only clause boundaries still visible. */
const CLAUSE_BREAK_RE =
  /^(?:and|but|or|nor|so|yet|then|when|while|as|after|before|because|since|until|till|once|where|that|who|whom|whose|which|if|though|although|unless|whenever)$/;

/** Finite-LOOKING verb forms: 3rd-person -s ("grows" — but not base forms in -ss/-us
 *  like "press"/"focus") or a regular past in -ed (but not base forms in -eed like
 *  "bleed"/"proceed"). A bare infinitive is a BASE form, so a changed word that already
 *  looks finite is never given the perception-verb exemption. */
const FINITE_FORM_RE = /(?:[^su]s|[^e]ed)$/;

/** Base verbs that themselves END in -ed (the one shape the suffix test misreads as a
 *  past form): "watched the blade embed itself", "watched them wed". */
const BASE_ED_VERB_RE = /^(?:embed|imbed|wed|shed|sled|tread)$/;

/** Finite forms the suffix test can't see. A change to one of these is a finite-verb
 *  edit — a real candidate slip — so it must never get the bare-infinitive exemption:
 *  irregular copula/auxiliaries ("He noticed the streets are empty." → "were"), modals
 *  ("She felt she can trust him." → "could" — a bare infinitive is never a modal), and
 *  common irregular PASTS, which are how present-tense narration slips read ("She
 *  watches the sun rose…" → "rise"). ("be" is deliberately absent: as a changed word it
 *  is almost always a true bare infinitive, e.g. "let it be". "had"/"would" never appear
 *  — tenseSig rewrites them. Pasts identical to their base form — set, put, let, cut —
 *  are undecidable and stay exempt.) */
const IRREGULAR_FINITE_RE =
  /^(?:are|were|am|have|do|did|can|could|may|might|shall|should|will|must|came|went|ran|fell|rose|stood|sat|took|got|gave|found|knew|grew|drew|threw|flew|spoke|broke|drove|rode|wrote|ate|drank|sang|rang|sank|swam|began|became|held|left|met|said|told|kept|slept|brought|bought|thought|taught|caught|fought|sought|stole|chose|froze|wore|tore|swore|hung|swung|struck|stuck)$/;

/** True when the changed word already looks like a FINITE verb form — i.e. a genuine
 *  candidate slip that must never receive the bare-infinitive exemption. */
function looksFinite(word: string): boolean {
  return (FINITE_FORM_RE.test(word) && !BASE_ED_VERB_RE.test(word)) || IRREGULAR_FINITE_RE.test(word);
}

/** Determiners: when one sits directly BEFORE a perception-verb lookalike, that word is
 *  a NOUN, not a verb ("a sense of dread", "the watch", "his make of engine") and must
 *  not grant the exemption — the walk-back continues past it instead. Only words that
 *  can NEVER float before a real verb belong here: "one"/"each"/"all" are excluded
 *  because they precede true perception verbs constantly ("No one saw the lights
 *  flicker", "they each watched the flames rise"). Known limitation: an adjective
 *  between determiner and noun ("the old watches tick") defeats this one-token check —
 *  a wider window would misread "the man felt…" and break the primary exemption. */
const DETERMINER_RE = /^(?:a|an|the|this|these|those|his|her|their|its|my|your|our|some|any|no|every)$/;

/** True when the suggestion's change inflects a BARE INFINITIVE that a perception/
 *  causative verb governs ("He felt the pressure build…" → "…built…"). The finite
 *  perception verb already carries the sentence's tense; its bare-verb complement is
 *  non-finite and correct in both tenses, so "fixing" it is a false positive. We walk
 *  back from the changed base-form word looking for an UNCHANGED perception verb in the
 *  same clause; a clause boundary ends the search so a genuine slip in a following
 *  clause ("They felt tired and walk away.") is still flagged. */
function bareInfinitiveComplement(phrase: string, fix: string): boolean {
  const pw = tenseSig(phrase).split(' ');
  const fw = tenseSig(fix).split(' ');
  if (pw.length !== fw.length) {
    return false; // only meaningful for aligned 1:1 verb swaps
  }
  for (let i = 0; i < pw.length; i++) {
    if (pw[i] === fw[i] || looksFinite(pw[i])) {
      continue; // unchanged, or the changed word already looks finite (a real slip)
    }
    for (let j = i - 1; j >= 0; j--) {
      if (CLAUSE_BREAK_RE.test(pw[j])) {
        break; // clause boundary — anything before it doesn't govern word i
      }
      // A perception verb governs word i — unless a determiner precedes it, which makes
      // it a NOUN ("the watch glow…" is a real slip); then keep walking ("he felt the
      // watch tick" still finds the true governor further back).
      if (pw[j] === fw[j] && PERCEPTION_VERB_RE.test(pw[j]) && !(j > 0 && DETERMINER_RE.test(pw[j - 1]))) {
        return true;
      }
    }
  }
  return false;
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
 *  speech isn't bound to the book's narrative tense. Exported for tests. */
export const tenseAccept: ProofreadPass['accept'] = ({ phrase, fix, reason }) => {
  const sp = tenseSig(phrase);
  const sf = tenseSig(fix);
  return (
    sp !== sf &&
    !nonTenseReason(reason) &&
    tenseSig(stripDialogue(phrase)) !== tenseSig(stripDialogue(fix)) &&
    // A genuine tense slip is a 1:1 verb-form swap (likes→liked, is→was), so the
    // normalized word counts must match. This rejects the model's stylistic rewrites
    // that ADD or DROP words — e.g. "…at Blueprint." → "…at Blueprint did he think."
    sp.split(' ').length === sf.split(' ').length &&
    // Reject "corrections" of -ing participles/gerunds (paving→paved) — they're
    // non-finite and correct in past-tense narration, the #1 tense false positive.
    !convertsParticiple(phrase, fix) &&
    // Reject "corrections" of a bare infinitive governed by a perception/causative
    // verb ("felt the pressure build" → "built") — the finite perception verb already
    // carries the tense; its bare-verb complement is non-finite and correct as-is.
    !bareInfinitiveComplement(phrase, fix)
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
