import { AiClient } from '../ai/AiClient';
import { AI_CONTEXT_TOKENS } from '../../constants';

/** Schema forcing a clean array of single-word corrections — no preamble, no
 *  numbering, no explanatory phrases (which a tiny model otherwise leaks). */
const SPELL_SCHEMA = {
  type: 'object',
  properties: {
    corrections: { type: 'array', items: { type: 'string' }, maxItems: 8 }
  },
  required: ['corrections']
} as const;

/**
 * Context-aware spelling corrections via the AI helper (or main) model. The
 * model sees the misspelled word AND its sentence, so it can pick the correction
 * the writer actually meant — where a dictionary, knowing nothing of context,
 * often ranks an unrelated near-match first (and can't tell their/there/they're
 * apart). Output is schema-constrained to a clean word array; we additionally
 * keep only single tokens. Callers should still validate against the dictionary
 * (the model can propose a plausible-looking non-word). Never throws — callers
 * fall back to the dictionary's own suggestions.
 */
export async function aiSpellSuggestions(
  client: AiClient,
  word: string,
  sentence: string,
  max: number,
  signal?: AbortSignal
): Promise<string[]> {
  const system =
    'You are a precise spelling corrector for prose. Given a misspelled word and the sentence it ' +
    'appears in, return the most likely intended spellings — the ones that fit THIS sentence — best ' +
    'guess first. Each item is a single correctly-spelled word only.';
  const user =
    (sentence ? `Sentence: "${sentence}"\n` : '') +
    `The word "${word}" is misspelled. Return up to ${max} correctly-spelled single words that fit ` +
    `this context, best guess first, preserving the writer’s apparent meaning.`;

  const text = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    () => {},
    signal,
    { format: SPELL_SCHEMA, numCtx: AI_CONTEXT_TOKENS, think: false, numPredict: 512, temperature: 0.2 }
  );

  return cleanCorrections(text, word).slice(0, max);
}

/** Schema for the batched, per-paragraph proofread: a verdict for each
 *  dictionary-flagged word, plus any grammar/word-choice errors found. */
const PROOFREAD_SCHEMA = {
  type: 'object',
  properties: {
    words: {
      type: 'array',
      maxItems: 40,
      items: {
        type: 'object',
        properties: {
          word: { type: 'string' },
          misspelling: { type: 'boolean' },
          corrections: { type: 'array', items: { type: 'string' }, maxItems: 6 }
        },
        required: ['word', 'misspelling', 'corrections']
      }
    },
    grammar: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          phrase: { type: 'string' },
          message: { type: 'string' },
          fix: { type: 'string' },
          category: { type: 'string' }
        },
        required: ['phrase', 'message', 'fix', 'category']
      }
    }
  },
  required: ['words', 'grammar']
} as const;

/** A verdict for one dictionary-flagged word. */
export interface WordVerdict {
  word: string;
  /** True = genuine typo; false = a real word the dictionary doesn't know (name,
   *  slang, sound, brand, foreign/coined term). Undefined = no usable answer. */
  misspelling?: boolean;
  corrections: string[];
}

/** A grammar / word-choice error to underline (different color from spelling). */
export interface GrammarIssue {
  /** The exact wrong text in the paragraph (used to anchor the underline). */
  phrase: string;
  /** Short human reason ("their → there"). */
  message: string;
  /** The corrected replacement for `phrase`. */
  fix: string;
}

export interface ProofreadResult {
  words: WordVerdict[];
  grammar: GrammarIssue[];
}

/**
 * Proofreads ONE paragraph in a single model call (≈Gemma 4 E2B class): for each
 * dictionary-flagged word it judges typo-vs-intentional (a name/slang/sound/brand/
 * foreign/coined word the dictionary just doesn't know), and it finds clear
 * GRAMMAR / word-choice errors (their↔there, its↔it’s, agreement, missing word).
 * One call per paragraph (vs. one per word) gives full-paragraph context and far
 * fewer requests. A tiny model can't do this — callers gate suppression on an
 * independent signal (the dictionary-distance guard in aiDocSpell). Never throws.
 */
export async function proofreadParagraph(
  client: AiClient,
  paragraph: string,
  flaggedWords: string[],
  signal?: AbortSignal
): Promise<ProofreadResult> {
  const system =
    'You are a meticulous proofreader for a NOVEL. You get a paragraph and a list of words a dictionary ' +
    'flagged as unknown. Do TWO things.\n' +
    '1) For EACH flagged word: set misspelling=true with up to 6 correctly-spelled single-word ' +
    'corrections that fit the sentence IF it is a genuine typo; otherwise set misspelling=false with an ' +
    'empty list IF it is a correctly-spelled real word the dictionary just does not know — a character/' +
    'place NAME, dialect, slang, brand, foreign word, technical/coined term, or a deliberate sound like ' +
    '"Ahhhhgkkk".\n' +
    '2) Find ONLY hard MECHANICAL grammar errors among the CORRECTLY-SPELLED words. The ALLOWED ' +
    'categories are EXACTLY these six — set "category" to one of them verbatim:\n' +
    '   - "homophone": wrong homophone (their/there/they’re, its/it’s, your/you’re, to/too).\n' +
    '   - "agreement": subject–verb or noun–number disagreement (e.g. "they was").\n' +
    '   - "missing-word": a clearly omitted function word (a dropped "the"/"to"/"a").\n' +
    '   - "doubled-word": an accidentally repeated word ("the the").\n' +
    '   - "capitalization": a sentence that does not start with a capital.\n' +
    '   - "punctuation": a missing or duplicated terminal mark.\n' +
    'For each, return the exact wrong text as "phrase", its "category", a short "message", and the ' +
    'corrected "fix".\n' +
    'NEVER flag anything outside those six categories. In particular DO NOT flag preposition choice, ' +
    'idioms, word choice, phrasing, wordiness, redundancy, clarity, style, tone, voice, or narrative ' +
    'tense — those are NOT errors. Example: "waved goodbye over his head" is correct — do NOT "fix" the ' +
    'preposition. When in doubt, leave "grammar" EMPTY.\n' +
    'IMPORTANT: a misspelled flagged word is NOT a grammar error — report it ONLY in step 1 (with ' +
    'corrections), never in grammar. Use empty arrays when nothing applies.';
  const user =
    `Paragraph:\n"""${paragraph}"""\n\nDictionary-flagged words: ${
      flaggedWords.length ? flaggedWords.map((w) => `"${w}"`).join(', ') : '(none)'
    }`;

  try {
    const text = await client.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      () => {},
      signal,
      { format: PROOFREAD_SCHEMA, numCtx: AI_CONTEXT_TOKENS, think: false, numPredict: 768, temperature: 0.2 }
    );
    return parseProofread(text, flaggedWords, paragraph);
  } catch {
    return { words: [], grammar: [] };
  }
}

/** Grammar findings survive only when the model labels them a HARD mechanical
 *  category. The subjective ones a small model invents — preposition/idiom/word-
 *  choice/phrasing/style/clarity — are dropped outright (e.g. it "corrects" the
 *  perfectly fine "waved goodbye over his head"). Default-deny: an unrecognized or
 *  missing category is dropped. */
const MECHANICAL_GRAMMAR_RE =
  /homophon|agreement|subject.?verb|missing.?word|doubled?.?word|repeated.?word|capitali|punctuation|article|a\/an/i;

/** Parses the proofread reply: keep only verdicts for words the dictionary
 *  actually flagged (preserving their original casing), and only grammar issues
 *  whose `phrase` really appears in the paragraph and differs from its `fix`. */
function parseProofread(text: string, flaggedWords: string[], paragraph: string): ProofreadResult {
  let obj: { words?: unknown[]; grammar?: unknown[] };
  try {
    obj = JSON.parse(text);
  } catch {
    return { words: [], grammar: [] };
  }
  const flagged = new Map(flaggedWords.map((w) => [w.toLowerCase(), w]));
  const words: WordVerdict[] = [];
  if (Array.isArray(obj.words)) {
    for (const raw of obj.words as Array<Record<string, unknown>>) {
      const orig = flagged.get(String(raw?.word ?? '').toLowerCase());
      if (!orig) {
        continue; // ignore words the dictionary didn't flag (model noise)
      }
      const rawCorr = Array.isArray(raw?.corrections)
        ? (raw.corrections as unknown[]).map((c) => String(c).trim().toLowerCase())
        : [];
      // If the model's only "correction" IS the word itself, it considers the word
      // correctly spelled — a real word the dictionary just doesn't know (it returned
      // misspelling=true by reflex). Treat it as cleared, not a typo with no fix.
      const selfCorrect = rawCorr.includes(orig.toLowerCase());
      const misspelling = selfCorrect
        ? false
        : typeof raw?.misspelling === 'boolean'
          ? raw.misspelling
          : undefined;
      words.push({ word: orig, misspelling, corrections: cleanCorrections(JSON.stringify(raw), orig) });
    }
  }
  const verdictWords = new Set(words.map((w) => w.word.toLowerCase()));
  const grammar: GrammarIssue[] = [];
  if (Array.isArray(obj.grammar)) {
    for (const raw of obj.grammar as Array<Record<string, unknown>>) {
      const phrase = String(raw?.phrase ?? '').trim();
      const fix = String(raw?.fix ?? '').trim();
      const message = String(raw?.message ?? '').trim();
      if (!phrase || !fix || phrase === fix || !message || message === 'message') {
        continue;
      }
      // Keep only HARD mechanical errors. The model tags each finding with a category;
      // drop anything it can't justify as one of the allowed six (so preposition/idiom/
      // word-choice/style — the subjective calls a small model invents — never surface).
      if (!MECHANICAL_GRAMMAR_RE.test(String(raw?.category ?? ''))) {
        continue;
      }
      // A single dictionary-flagged MISSPELLED word sometimes comes back mislabeled
      // as a grammar issue (a one-word phrase rewrite). Those belong in the SPELLING
      // channel (red squiggle + word suggestions), never the grammar (blue) one —
      // so reroute them and recover the corrected word from the fix when possible.
      const tokens = new Set(phrase.toLowerCase().match(/[\p{L}\p{N}'’-]+/gu) ?? []);
      const flaggedHere = [...flagged.keys()].filter((lw) => tokens.has(lw));
      if (flaggedHere.length > 0) {
        for (const lw of flaggedHere) {
          if (verdictWords.has(lw)) {
            continue; // already have a spelling verdict for it
          }
          const corr = singleTokenFix(phrase, fix, lw);
          words.push({ word: flagged.get(lw)!, misspelling: true, corrections: corr ? [corr] : [] });
          verdictWords.add(lw);
        }
        continue; // do NOT also show it as a grammar error
      }
      // Keep only a real, short, applicable change that anchors to the paragraph.
      // The length cap rejects the model's occasional degenerate entry where it
      // echoes the whole sentence as the "phrase" (a real grammar error is short).
      if (phrase.length <= 60 && paragraph.includes(phrase)) {
        grammar.push({ phrase, message, fix });
      }
    }
  }
  return { words, grammar };
}

/** When a phrase→fix change replaces exactly one word and that word is the flagged
 *  misspelling, return its corrected form (so the spelling card can suggest it).
 *  Undefined when the change isn't a clean single-word substitution. */
function singleTokenFix(phrase: string, fix: string, flaggedLower: string): string | undefined {
  const p = phrase.split(/\s+/);
  const f = fix.split(/\s+/);
  if (p.length !== f.length) {
    return undefined;
  }
  const strip = (t: string) => t.replace(/[^\p{L}\p{N}'’-]/gu, '');
  let idx = -1;
  let diffs = 0;
  for (let i = 0; i < p.length; i++) {
    if (strip(p[i]).toLowerCase() !== strip(f[i]).toLowerCase()) {
      diffs++;
      idx = i;
    }
  }
  if (diffs !== 1 || strip(p[idx]).toLowerCase() !== flaggedLower) {
    return undefined;
  }
  const corr = strip(f[idx]);
  return corr && !/\s/.test(corr) ? corr : undefined;
}

/** Parses the model reply (schema JSON, or a comma/newline list as a fallback)
 *  into clean, de-duplicated SINGLE words, excluding the original token. */
export function cleanCorrections(text: string, word: string): string[] {
  let raw: string[] = [];
  try {
    const obj = JSON.parse(text);
    if (Array.isArray(obj?.corrections)) {
      raw = obj.corrections.map((x: unknown) => String(x));
    }
  } catch {
    raw = text.split(/[,\n]/);
  }
  const lower = word.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const w = item.replace(/[^\p{L}\p{N}'’\- ]/gu, '').trim();
    // Single tokens only — drop phrases like "will receive" the model may emit.
    if (!w || /\s/.test(w)) {
      continue;
    }
    const key = w.toLowerCase();
    if (key !== lower && !seen.has(key)) {
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}
