/** Whole-document AI passive-voice pass for the live editor underline. Unlike the
 *  old regex underline (which flagged EVERY passive), the model JUDGES each passive
 *  sentence and flags it only when an active-voice rewrite would genuinely improve
 *  it — stricter in narration, lenient inside dialogue. The caller
 *  (ProserEditorProvider) throttles, caches, and gates this; here we run one analysis
 *  and return the sentences to underline. Modeled on aiTense.ts. */
import { AiClient } from '../ai/AiClient';
import { PASSIVE_RE, passiveHits } from './passiveRegex';
import { ProofreadFinding, ProofreadPass, proofreadDocument } from './proofreadPass';

/** A passive-voice finding to underline. Structurally a {@link ProofreadFinding}
 *  (identical to TenseFinding) so the webview reuses the same painting machinery:
 *  `phrase` is the verbatim sentence; `fix` is the model's active-voice rewrite. */
export type PassiveFinding = ProofreadFinding;

const SYSTEM =
  'You are a prose editor judging PASSIVE VOICE in fiction. You do not flag passive ' +
  'voice mechanically — you decide, case by case, whether rewriting a passive sentence ' +
  'in ACTIVE voice would genuinely make it stronger, and you flag ONLY those. Passive ' +
  'voice is often the correct choice and must be left alone when it is. You respond ' +
  'with STRICT JSON only — no prose, no code fences.';

function buildUser(body: string): string {
  return (
    'Step 1: Find every passive-voice construction in the prose below (a form of "to be" ' +
    '— is, are, was, were, be, been, being — plus a past participle, where the subject ' +
    'receives the action instead of performing it).\n' +
    'Step 2: For EACH passive construction, decide whether rewriting it in active voice ' +
    'would GENUINELY IMPROVE the sentence. Include a sentence in your output ONLY if active ' +
    'voice is clearly better. When passive is fine, or when you are genuinely unsure, LEAVE IT OUT.\n' +
    'KEEP passive (do NOT flag) when ANY of these is true:\n' +
    '- The doer of the action is unknown, unimportant, or obvious from context ("The window ' +
    'had been broken." — who broke it doesn\'t matter).\n' +
    '- The writer is deliberately emphasizing the RECIPIENT of the action rather than the doer ' +
    '("She was raised by her grandmother." keeps focus on her).\n' +
    '- A formal, ceremonial, official, or ritual register is clearly intended ("The accused was ' +
    'found guilty.", "The vows were spoken.").\n' +
    '- Naming the doer would be clumsier or would awkwardly insert a vague subject like ' +
    '"someone" or "people".\n' +
    '- The participle is really a predicate adjective describing a STATE, not an action ("She ' +
    'was tired.", "The door was locked.").\n' +
    'FLAG passive (rewrite to active) when:\n' +
    '- The doer is present, known, and more vivid as the subject ("The ball was thrown by the ' +
    'boy." → "The boy threw the ball.").\n' +
    '- The passive is evasive, flat, or wordy where an active version is tighter and more direct.\n' +
    'DIALOGUE vs NARRATION — weight your judgment by where the sentence sits:\n' +
    '- NARRATION / DESCRIPTION (text OUTSIDE quotation marks): be stricter. This is where flat ' +
    'passive most weakens fiction, so flag it more readily here.\n' +
    '- DIALOGUE (text INSIDE quotation marks): be lenient. Characters speak naturally and passive ' +
    'is normal speech. Flag a line of dialogue ONLY if it is markedly awkward.\n' +
    'Examples:\n' +
    '- KEEP: "The bridge had been built centuries before anyone could remember." — the builders ' +
    'are unknown and unimportant; passive is correct. Do NOT include it.\n' +
    '- FLAG: "The letter was written by Marcus in a trembling hand." → suggestion "Marcus wrote ' +
    'the letter in a trembling hand." reason "Marcus is the vivid doer; active is tighter."\n' +
    'Rules:\n' +
    '- Copy "sentence" BYTE-FOR-BYTE from the text exactly as it appears, so it can be located. ' +
    'Never paraphrase the original.\n' +
    '- "suggestion" must be the SAME sentence rewritten in ACTIVE voice; it MUST differ from the ' +
    'original and must not still be passive.\n' +
    '- "reason" is a SHORT phrase saying why active voice is better here.\n' +
    '- Include a sentence ONLY if active voice genuinely improves it. When in doubt, LEAVE IT OUT.\n' +
    '- Do NOT think out loud. Output JSON only.\n' +
    'Return STRICT JSON only — no prose, no code fences — of this shape:\n' +
    '{"issues":[{"sentence":"<the passive sentence copied EXACTLY from the text>",' +
    '"suggestion":"<that sentence rewritten in active voice>","reason":"<short why active is better>"}]}\n' +
    'Max 40 issues. Empty "issues" array if none should change.\n\n---\n' +
    body
  );
}

/** True when the model's "reason" clearly says it meant to KEEP the passive — a leak
 *  we drop so a kept sentence never underlines. Matched with precise phrases (not bare
 *  tokens like "keep"/"state"/"formal") so it never swallows a legitimate FLAG reason
 *  like "active keeps it tighter" or "the doer's state is vivid". */
function keepReason(reason: string): boolean {
  return /passive is (?:fine|correct|appropriate|better|preferred|intentional)|keep(?:s|ing)? (?:the |it )?passive|(?:intentional|deliberate)(?:ly)? passive|leave (?:it|as|in) passive|emphasi[sz]e[sd]? the recipient|doer is (?:unknown|unimportant)/i.test(
    reason
  );
}

/** The passive pass. A cheap regex pre-filter keeps passive-free windows off the
 *  model; a finding is kept only when the rewrite actually REMOVES passive voice and
 *  the model's reason isn't a "keep the passive" explanation. */
const PASSIVE_PASS: ProofreadPass = {
  system: SYSTEM,
  buildUser,
  defaultMessage: 'Passive voice — consider active',
  skipChunk: (chunk) => {
    PASSIVE_RE.lastIndex = 0;
    return !PASSIVE_RE.test(chunk); // no passive candidate — don't call the model
  },
  accept: ({ phrase, fix, reason }) =>
    passiveHits(fix) < passiveHits(phrase) && !keepReason(reason)
};

/** Runs the passive analysis over the whole document. Resolves to the sentences to
 *  underline (deduped), [] when there are none, or null when every window that called
 *  the model returned unparseable output (caller keeps the prior squiggles). */
export function proofreadPassive(
  client: AiClient,
  text: string,
  signal?: AbortSignal
): Promise<PassiveFinding[] | null> {
  return proofreadDocument(client, text, PASSIVE_PASS, signal);
}
