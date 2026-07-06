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

/** Schema for the batched, per-paragraph proofread: a typo-vs-intentional verdict
 *  for each dictionary-flagged word. Grammar is NOT part of this — a small LLM
 *  hallucinates homophone "errors" (flagging the correct possessive "their" as
 *  "they're"), so grammar is owned solely by Harper (see harperGrammar.ts). */
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
    }
  },
  required: ['words']
} as const;

/** A verdict for one dictionary-flagged word. */
export interface WordVerdict {
  word: string;
  /** True = genuine typo; false = a real word the dictionary doesn't know (name,
   *  slang, sound, brand, foreign/coined term). Undefined = no usable answer. */
  misspelling?: boolean;
  corrections: string[];
}

export interface ProofreadResult {
  words: WordVerdict[];
}

/**
 * Proofreads ONE paragraph in a single model call (≈Gemma 4 E2B class): for each
 * dictionary-flagged word it judges typo-vs-intentional (a name/slang/sound/brand/
 * foreign/coined word the dictionary just doesn't know) and offers corrections.
 * One call per paragraph (vs. one per word) gives full-paragraph context and far
 * fewer requests. A tiny model can't do this — callers gate suppression on an
 * independent signal (the dictionary-distance guard in aiDocSpell). Grammar is
 * deliberately NOT done here (Harper owns it — the LLM invents homophone errors).
 * Never throws.
 */
export async function proofreadParagraph(
  client: AiClient,
  paragraph: string,
  flaggedWords: string[],
  signal?: AbortSignal
): Promise<ProofreadResult> {
  const system =
    'You are a meticulous proofreader for a NOVEL. You get a paragraph and a list of words a dictionary ' +
    'flagged as unknown. For EACH flagged word: set misspelling=true with up to 6 correctly-spelled ' +
    'single-word corrections that fit the sentence IF it is a genuine typo; otherwise set ' +
    'misspelling=false with an empty list IF it is a correctly-spelled real word the dictionary just ' +
    'does not know — a character/place NAME, dialect, slang, brand, foreign word, technical/coined ' +
    'term, or a deliberate sound like "Ahhhhgkkk".\n' +
    'Judge ONLY the flagged words. Do NOT comment on grammar, homophones, punctuation, word choice, ' +
    'phrasing, or style — those are handled elsewhere. Use an empty array when a word needs no ' +
    'correction.';
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
    return parseProofread(text, flaggedWords);
  } catch {
    return { words: [] };
  }
}

/** Parses the proofread reply: keep only verdicts for words the dictionary
 *  actually flagged (preserving their original casing). Grammar is not parsed —
 *  Harper owns grammar; the model is asked for spelling verdicts only. */
function parseProofread(text: string, flaggedWords: string[]): ProofreadResult {
  let obj: { words?: unknown[] };
  try {
    obj = JSON.parse(text);
  } catch {
    return { words: [] };
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
  return { words };
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
