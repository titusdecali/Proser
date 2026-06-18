import nspell from 'nspell';
import { UserDictionary } from './userDictionary';

type Speller = ReturnType<typeof nspell>;

/** The base of an English possessive, or null if the token isn't one:
 *  "else's"/"Dana's" → "else"/"Dana"; "dogs'" → "dogs". */
function stripPossessive(token: string): string | null {
  if (/['’]s$/.test(token)) {
    return token.slice(0, -2);
  }
  if (/s['’]$/.test(token)) {
    return token.slice(0, -1);
  }
  return null;
}

/** Raw Hunspell dictionary data (Buffers) for one locale. */
export interface DictData {
  aff: Buffer;
  dic: Buffer;
}

/** Common English prefixes — accepted in front of a known stem so productive
 *  compounds like "cofounder", "oversized", or "pre-coffee" aren't flagged. */
const PREFIXES = [
  'co', 'pre', 're', 'un', 'non', 'anti', 'over', 'under', 'sub', 'super', 'semi',
  'multi', 'inter', 'intra', 'de', 'dis', 'mis', 'out', 'up', 'self', 'well', 'ex',
  'pro', 'counter', 'post', 'mid', 'off', 'meta', 'micro', 'macro', 'mini', 'trans'
];

/** Function words that should never be the FIRST half of a closed compound, so
 *  a run-together typo like "thecat" / "andthen" isn't waved through. (Genuine
 *  compounds such as "herself" or "anybody" are already in the dictionary and
 *  never reach the compound fallback.) */
const COMPOUND_STOP_FIRST = new Set([
  'the', 'and', 'for', 'but', 'nor', 'yet', 'are', 'was', 'were', 'you', 'his',
  'her', 'she', 'him', 'who', 'whom', 'why', 'how', 'did', 'does', 'done', 'had',
  'has', 'have', 'its', 'our', 'your', 'their', 'them', 'they', 'this', 'that',
  'then', 'than', 'with', 'from', 'not'
]);

/** Productive *derivational* suffixes the Hunspell dictionary often doesn't list
 *  (agent nouns, nominalizations, adjectives) — so "recycle"→"recycler",
 *  "disrupt"→"disruptor", "happy"→"happiness", "recycle"→"recyclable" aren't
 *  flagged. Inflectional suffixes (-ed/-ing/-s) are deliberately excluded:
 *  Hunspell already generates those with the correct consonant-doubling, so
 *  un-doubled typos like "occured" stay flagged. Longest-first. */
const DERIV_SUFFIXES = [
  'ization', 'isation', 'ation', 'ities', 'ments', 'able', 'ible', 'ness',
  'ment', 'less', 'ful', 'ity', 'ism', 'isms', 'ist', 'ists', 'ize', 'ise',
  'ers', 'ors', 'er', 'or'
].sort((a, b) => b.length - a.length);

/**
 * Language-aware Hunspell wrapper over nspell. English uses BOTH the US and
 * British dictionaries plus prose-tuned heuristics (proper-noun skip, prefix /
 * closed-compound acceptance). Other languages use their single Hunspell
 * dictionary with plain membership + suggestions — the English-only heuristics
 * would misfire elsewhere (e.g. German capitalizes every noun, so the
 * proper-noun rule would hide real errors).
 *
 * Dictionary data is supplied via {@link load} (the service handles bundling /
 * downloading), so the engine itself stays synchronous.
 */
export class SpellEngine {
  private spellers: Speller[] = [];
  private readonly added = new Set<string>();

  constructor(
    private readonly userDict: UserDictionary,
    readonly language: string
  ) {}

  /** Builds the spell instances from loaded dictionary data + the user words. */
  load(dicts: DictData[]): void {
    this.spellers = dicts.map((d) => nspell(d));
    for (const word of this.userDict.all()) {
      this.add(word);
    }
  }

  get ready(): boolean {
    return this.spellers.length > 0;
  }

  /** True if any loaded locale (or the user's additions) accepts the word. */
  private known(word: string): boolean {
    if (this.spellers.length === 0) {
      return true;
    }
    if (this.added.has(word.toLowerCase())) {
      return true;
    }
    const lw = word.toLowerCase();
    return this.spellers.some((s) => s.correct(word) || s.correct(lw));
  }

  /** A hyphen-part is correct if it's a known word, a known prefix, or a known
   *  stem behind a common prefix ("cofounder" → "founder"). English only. */
  private partCorrect(part: string): boolean {
    if (part.length < 2) {
      return true;
    }
    if (this.known(part)) {
      return true;
    }
    const lower = part.toLowerCase();
    if (PREFIXES.includes(lower)) {
      return true;
    }
    for (const pre of PREFIXES) {
      if (lower.length > pre.length + 2 && lower.startsWith(pre) && this.known(lower.slice(pre.length))) {
        return true;
      }
    }
    return false;
  }

  /** A closed compound the dictionary lacks but that splits cleanly into two
   *  known words ("rearview" → rear+view). Each half ≥3 letters and the first
   *  half can't be a bare function word. English only. */
  private closedCompoundOk(word: string): boolean {
    const lw = word.toLowerCase();
    if (lw.length < 6) {
      return false;
    }
    for (let i = 3; i <= lw.length - 3; i++) {
      const first = lw.slice(0, i);
      if (COMPOUND_STOP_FIRST.has(first)) {
        continue;
      }
      if (this.known(first) && this.known(lw.slice(i))) {
        return true;
      }
    }
    return false;
  }

  /** True if the token is correctly spelled, a number, ALL-CAPS (acronym /
   *  invented term), user-added, or — in English — a hyphen/prefix/closed
   *  compound of known parts. */
  isCorrect(token: string): boolean {
    if (this.spellers.length === 0) {
      return true; // engine unavailable — never flag
    }
    if (/\d/.test(token)) {
      return true; // skip anything with digits
    }
    if (this.userDict.has(token)) {
      return true;
    }
    // ALL-CAPS acronyms / invented terms (CRYOPULSE, KESS) — never flag.
    if (token.length >= 2 && token === token.toUpperCase() && /\p{Lu}/u.test(token)) {
      return true;
    }
    if (this.language === 'en') {
      if (this.accepted(token)) {
        return true;
      }
      // Possessives: "else's", "boss's", "dogs'" — accept if the base is fine.
      const base = stripPossessive(token);
      return base !== null && this.accepted(base);
    }
    // Other languages: each hyphen part must simply be a known word.
    return token.split('-').every((part) => this.known(part));
  }

  /** English acceptance for a (possibly hyphenated) word: each part is a known
   *  word, a known prefix+stem, or a clean closed compound. */
  private englishWordOk(token: string): boolean {
    return token
      .split('-')
      .every((part) => this.partCorrect(part) || this.closedCompoundOk(part));
  }

  /** A directly-valid English word OR a productive derivation of one. */
  private accepted(token: string): boolean {
    return this.englishWordOk(token) || this.derivedOk(token);
  }

  /** Accepts a productive *derivation* of a known stem that the dictionary lacks
   *  ("recycle"→"recycler", "disrupt"→"disruptor", "happy"→"happiness"). Tries
   *  each derivational suffix with the usual spelling reconstructions (drop-e,
   *  y-restoration, de-doubling). Only fires as a fallback for words the normal
   *  checks reject, so cost is bounded to would-be misspellings. English only. */
  private derivedOk(word: string): boolean {
    const lw = word.toLowerCase();
    if (lw.length < 5) {
      return false;
    }
    for (const suf of DERIV_SUFFIXES) {
      if (lw.length <= suf.length + 2 || !lw.endsWith(suf)) {
        continue;
      }
      const stem = lw.slice(0, -suf.length);
      const candidates = [stem, stem + 'e']; // drop-e: "recycle" → "recycler"
      if (stem.endsWith('i')) {
        candidates.push(stem.slice(0, -1) + 'y'); // "happi" → "happy"
      }
      const last = stem[stem.length - 1];
      if (stem.length >= 3 && last === stem[stem.length - 2] && !'aeiou'.includes(last)) {
        candidates.push(stem.slice(0, -1)); // de-double: "runner" → "run"
      }
      if (candidates.some((c) => c.length >= 2 && this.englishWordOk(c))) {
        return true;
      }
    }
    return false;
  }

  suggest(word: string): string[] {
    if (this.spellers.length === 0) {
      return [];
    }
    const out = [...this.spellers[0].suggest(word)];
    for (let i = 1; i < this.spellers.length && out.length < 5; i++) {
      for (const w of this.spellers[i].suggest(word)) {
        if (!out.includes(w)) {
          out.push(w);
        }
      }
    }
    return out.slice(0, 8);
  }

  /** Adds a word to the live engines (persistence is handled by UserDictionary). */
  add(word: string): void {
    this.added.add(word.toLowerCase());
    this.spellers.forEach((s) => s.add(word));
  }
}
