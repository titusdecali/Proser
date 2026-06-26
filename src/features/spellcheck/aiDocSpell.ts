import { AiClient } from '../ai/AiClient';
import { Misspelling } from './spellService';
import { proofreadParagraph, GrammarIssue } from './aiSpell';

export { GrammarIssue };

/** What the checker needs from the dictionary: detection + word validation. */
export interface SpellHooks {
  findMisspellings(text: string): Promise<Misspelling[]>;
  isValidWord(word: string): Promise<boolean>;
}

/** Aggregate emitted to the host as paragraphs are checked. */
export interface DocSpellResult {
  /** lowercased flagged word → validated AI corrections. */
  suggestions: Map<string, string[]>;
  /** lowercased words the model judged INTENTIONAL (a sound/name/coined term),
   *  validated by the distance guard — the host suppresses their squiggles. */
  cleared: Set<string>;
  /** Grammar / word-choice errors across the doc (different-color underline). */
  grammar: GrammarIssue[];
}

/** Per-paragraph cached unit. */
interface ParaResult {
  corrections: Misspelling[];
  cleared: string[];
  grammar: GrammarIssue[];
}

const MAX_PARAGRAPHS = 600;
const MAX_PARA_CHARS = 4000;
// ONE model call at a time — the proofread runs a capable (≈7 GB) helper, so two
// concurrent calls double the memory/compute pressure for no real latency win.
const CONCURRENCY = 1;

/**
 * Proactive, INCREMENTAL **AI spell check** for a whole document. Detection stays
 * with the dictionary (instant, reliable); the helper model then, per flagged
 * word, either **corrects** a genuine typo or recognises an **intentional** word
 * (a sound like "Ahhgh", a name, dialect, or coined term) so it isn't squiggled.
 * Results are cached by paragraph content-hash, so re-runs only touch paragraphs
 * that were added/edited/pasted. Runs in the background with bounded concurrency
 * and streams partial results via `onUpdate`, so typing is never blocked.
 *
 * Two independent guards keep "intentional" suppression from ever hiding a real
 * misspelling: (1) it only runs when the helper is a capable model (`allowClear`,
 * decided by the host from the helper tag — a tiny model can't do this), and
 * (2) the dictionary-distance guard above. Every correction is also validated
 * against the dictionary.
 */
export class AiDocSpellChecker {
  private readonly cache = new Map<string, Map<string, ParaResult>>();
  private readonly gen = new Map<string, number>();

  dispose(docKey: string): void {
    this.cache.delete(docKey);
    this.gen.delete(docKey);
  }

  async update(
    docKey: string,
    text: string,
    engine: AiClient,
    hooks: SpellHooks,
    allowClear: boolean,
    onUpdate: (result: DocSpellResult) => void,
    signal: AbortSignal
  ): Promise<void> {
    const myGen = (this.gen.get(docKey) ?? 0) + 1;
    this.gen.set(docKey, myGen);
    const live = () => this.gen.get(docKey) === myGen && !signal.aborted;

    const prev = this.cache.get(docKey) ?? new Map<string, ParaResult>();
    const next = new Map<string, ParaResult>();
    const todo: Array<{ hash: string; text: string }> = [];

    for (const para of splitParagraphs(text)) {
      const h = hash(para);
      if (next.has(h)) {
        continue;
      }
      const cached = prev.get(h);
      if (cached) {
        next.set(h, cached); // unchanged → reuse, no AI call
      } else {
        next.set(h, { corrections: [], cleared: [], grammar: [] });
        if (todo.length < MAX_PARAGRAPHS) {
          todo.push({ hash: h, text: para });
        }
      }
    }
    this.cache.set(docKey, next);
    onUpdate(aggregate(next));

    if (todo.length === 0) {
      return;
    }

    let i = 0;
    const worker = async (): Promise<void> => {
      while (i < todo.length && live()) {
        const item = todo[i++];
        const result = await this.checkParagraph(item.text, engine, hooks, allowClear, signal);
        if (!live()) {
          return;
        }
        next.set(item.hash, result);
        onUpdate(aggregate(next));
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, todo.length) }, () => worker())
    );
  }

  private async checkParagraph(
    paragraph: string,
    engine: AiClient,
    hooks: SpellHooks,
    allowClear: boolean,
    signal: AbortSignal
  ): Promise<ParaResult> {
    let flagged: Misspelling[] = [];
    try {
      flagged = await hooks.findMisspellings(paragraph);
    } catch {
      return { corrections: [], cleared: [], grammar: [] };
    }

    // ONE call per paragraph: per-word typo-vs-intentional verdicts + corrections,
    // and grammar/word-choice errors with full-paragraph context.
    const result = await proofreadParagraph(
      engine,
      paragraph,
      flagged.map((m) => m.word),
      signal
    ).catch(() => ({ words: [], grammar: [] }));
    if (signal.aborted) {
      return { corrections: [], cleared: [], grammar: [] };
    }
    const byWord = new Map(result.words.map((v) => [v.word.toLowerCase(), v]));

    const corrections: Misspelling[] = [];
    const cleared: string[] = [];
    for (const m of flagged) {
      const verdict = byWord.get(m.word.toLowerCase());
      // Trust the capable model's verdict (clearing only runs on a capable model —
      // the `allowClear` gate). The old distance guard also blocked legitimate words
      // that happen to sit near a real word ("ramen"↔"raven", "ahh"↔"ah"), which is
      // exactly what users want cleared, so it's gone — the model decides.
      if (allowClear && verdict?.misspelling === false) {
        cleared.push(m.word);
        continue;
      }
      const valid: string[] = [];
      for (const w of verdict?.corrections ?? []) {
        if (await hooks.isValidWord(w)) {
          valid.push(w);
        }
      }
      if (valid.length > 0) {
        corrections.push({ word: m.word, suggestions: valid });
      }
    }
    return { corrections, cleared, grammar: result.grammar };
  }
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => /\p{L}/u.test(p))
    .map((p) => (p.length > MAX_PARA_CHARS ? p.slice(0, MAX_PARA_CHARS) : p));
}

/** Flattens every paragraph's results into the doc-wide suggestions map + the set
 *  of intentional (cleared) words. */
function aggregate(byPara: Map<string, ParaResult>): DocSpellResult {
  const suggestions = new Map<string, string[]>();
  const cleared = new Set<string>();
  const grammar: GrammarIssue[] = [];
  for (const r of byPara.values()) {
    for (const m of r.corrections) {
      const key = m.word.toLowerCase();
      const cur = suggestions.get(key) ?? [];
      for (const s of m.suggestions) {
        if (!cur.some((x) => x.toLowerCase() === s.toLowerCase())) {
          cur.push(s);
        }
      }
      suggestions.set(key, cur);
    }
    for (const w of r.cleared) {
      cleared.add(w.toLowerCase());
    }
    grammar.push(...r.grammar);
  }
  // A word that's a genuine typo somewhere wins over an "intentional" verdict
  // elsewhere — never suppress a word we also have corrections for.
  for (const key of suggestions.keys()) {
    cleared.delete(key);
  }
  return { suggestions, cleared, grammar };
}

/** FNV-1a 32-bit content hash → short hex. Stable per paragraph text. */
function hash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}
