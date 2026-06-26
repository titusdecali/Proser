/**
 * Offline thesaurus via WordNet (the optional `wordpos` dependency). Loaded
 * lazily so the extension works without it. WordNet exposes synonyms well;
 * antonym data is not surfaced by wordpos, so offline antonyms return empty —
 * the online (Datamuse) path covers antonyms.
 */

import type { ThesaurusKind } from './datamuseClient';

let wordposInstance: any | undefined;
let unavailable = false;

export async function getWordpos(): Promise<any | undefined> {
  if (unavailable) {
    return undefined;
  }
  if (wordposInstance) {
    return wordposInstance;
  }
  try {
    const mod: any = await import('wordpos');
    const WordPOS = mod.default ?? mod;
    wordposInstance = new WordPOS();
    return wordposInstance;
  } catch {
    unavailable = true;
    return undefined;
  }
}

export async function fetchFromWordNet(
  word: string,
  kind: ThesaurusKind,
  max: number
): Promise<string[]> {
  if (kind === 'antonyms') {
    return []; // WordNet antonyms are not exposed by wordpos.
  }
  const wordpos = await getWordpos();
  if (!wordpos) {
    return [];
  }

  const results: any[] = await wordpos.lookup(word);
  const seen = new Set<string>();
  const lower = word.toLowerCase();
  for (const synset of results ?? []) {
    for (const syn of synset.synonyms ?? []) {
      const clean = String(syn).replace(/_/g, ' ').trim();
      if (clean && clean.toLowerCase() !== lower) {
        seen.add(clean);
      }
    }
  }
  return Array.from(seen).slice(0, Math.max(1, max));
}
