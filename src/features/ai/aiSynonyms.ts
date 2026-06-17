import { AiClient } from './AiClient';
import { ThesaurusKind } from '../thesaurus/datamuseClient';

/**
 * Context-aware synonyms/antonyms via the configured AI engine: the model sees
 * the surrounding sentence and returns words that fit that exact context.
 * Returns a clean word list (best-effort parse of a comma-separated reply).
 */
export async function aiContextSuggestions(
  client: AiClient,
  word: string,
  sentence: string,
  kind: ThesaurusKind,
  max: number,
  signal?: AbortSignal
): Promise<string[]> {
  const target = kind === 'synonyms' ? 'synonyms' : 'antonyms';
  const system =
    'You are a precise thesaurus and line editor. You suggest replacements that slot into the exact ' +
    'sentence — matching the target word’s part of speech, tense/inflection, number, register, and ' +
    'connotation, so the sentence still reads naturally. Reply ONLY with a comma-separated list, ' +
    'ordered best-fit first. No explanations, numbering, or quotes.';
  const user =
    `Sentence: "${sentence}"\n` +
    `Suggest up to ${max} ${target} that could replace "${word}" in THIS sentence without changing its ` +
    `meaning or grammar. Keep the same part of speech and tense/inflection as "${word}" (e.g. a past-tense ` +
    `verb stays past tense, a plural stays plural). Order them best-fit-for-this-context first. ` +
    `Lowercase unless a proper noun, comma-separated, no duplicates, and do not include "${word}" itself.`;

  const text = await client.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    () => {},
    signal
  );

  const lower = word.toLowerCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const w = raw.replace(/[^\p{L}\p{N}'\- ]/gu, '').trim();
    const key = w.toLowerCase();
    if (w && key !== lower && !seen.has(key)) {
      seen.add(key);
      out.push(w);
    }
  }
  return out.slice(0, max);
}
