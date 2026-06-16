/**
 * Datamuse thesaurus client. Free, no API key, requires internet.
 *   synonyms: https://api.datamuse.com/words?rel_syn=WORD
 *   antonyms: https://api.datamuse.com/words?rel_ant=WORD
 */

const BASE = 'https://api.datamuse.com/words';
const TIMEOUT_MS = 4000;

export type ThesaurusKind = 'synonyms' | 'antonyms';

interface DatamuseWord {
  word: string;
  score?: number;
}

export async function fetchFromDatamuse(
  word: string,
  kind: ThesaurusKind,
  max: number
): Promise<string[]> {
  const rel = kind === 'synonyms' ? 'rel_syn' : 'rel_ant';
  const url = `${BASE}?${rel}=${encodeURIComponent(word)}&max=${Math.max(1, Math.min(100, max))}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) {
      throw new Error(`Datamuse responded ${res.status}`);
    }
    const data = (await res.json()) as DatamuseWord[];
    return data
      .map((d) => d.word)
      .filter((w) => typeof w === 'string' && w.length > 0);
  } finally {
    clearTimeout(timer);
  }
}
