import nspell from 'nspell';
import { UserDictionary } from './userDictionary';

type Speller = ReturnType<typeof nspell>;

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
      return token
        .split('-')
        .every((part) => this.partCorrect(part) || this.closedCompoundOk(part));
    }
    // Other languages: each hyphen part must simply be a known word.
    return token.split('-').every((part) => this.known(part));
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
