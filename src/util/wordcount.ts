import { getProseSpans, ScanOptions } from './markdownScan';

/** A "word": a run of letters/digits, allowing internal apostrophes/hyphens
 *  (so "don't" and "well-known" count as one word each). */
const WORD_RE = /[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;

export interface ProseToken {
  word: string;
  /** Absolute start offset in the original document text. */
  start: number;
  /** Absolute end offset (exclusive). */
  end: number;
}

/** Counts words in a plain (already-stripped) string. */
export function countTokens(text: string): number {
  const matches = text.match(WORD_RE);
  return matches ? matches.length : 0;
}

/** Counts words in a Markdown document, honoring the prose/exclusion rules. */
export function countMarkdownWords(text: string, options: ScanOptions = {}): number {
  let total = 0;
  for (const span of getProseSpans(text, options)) {
    total += countTokens(text.slice(span.start, span.end));
  }
  return total;
}

/** Yields every prose word with its absolute document offsets — the basis for
 *  spell check and quality lint. */
export function getProseTokens(text: string, options: ScanOptions = {}): ProseToken[] {
  const tokens: ProseToken[] = [];
  for (const span of getProseSpans(text, options)) {
    const segment = text.slice(span.start, span.end);
    let m: RegExpExecArray | null;
    WORD_RE.lastIndex = 0;
    while ((m = WORD_RE.exec(segment)) !== null) {
      tokens.push({
        word: m[0],
        start: span.start + m.index,
        end: span.start + m.index + m[0].length
      });
    }
  }
  return tokens;
}

export interface ProseStats {
  words: number;
  characters: number;
  charactersNoSpaces: number;
  sentences: number;
  paragraphs: number;
}

/** Computes prose statistics over a Markdown document, honoring the
 *  prose/exclusion rules (code, frontmatter, URLs are skipped). Words,
 *  characters, and sentences come from the prose spans; paragraphs are
 *  approximated as blank-line-separated blocks that contain text. */
export function computeProseStats(text: string, options: ScanOptions = {}): ProseStats {
  let words = 0;
  let characters = 0;
  let charactersNoSpaces = 0;
  let sentences = 0;

  for (const span of getProseSpans(text, options)) {
    const segment = text.slice(span.start, span.end);
    words += countTokens(segment);
    characters += segment.length;
    charactersNoSpaces += segment.replace(/\s/g, '').length;
    const enders = segment.match(/[.!?]+(?=\s|$)/g);
    sentences += enders ? enders.length : 0;
  }

  const paragraphs = text
    .split(/\n\s*\n/)
    .filter((block) => /[\p{L}\p{N}]/u.test(block)).length;

  return { words, characters, charactersNoSpaces, sentences, paragraphs };
}

/** Reading time in whole minutes (rounded up, minimum 1 for non-empty text). */
export function estimateReadingMinutes(wordCount: number, wordsPerMinute: number): number {
  if (wordCount <= 0) {
    return 0;
  }
  return Math.max(1, Math.ceil(wordCount / Math.max(1, wordsPerMinute)));
}
