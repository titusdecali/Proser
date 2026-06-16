import nspell from 'nspell';
import { UserDictionary } from './userDictionary';

/**
 * Wraps nspell + the bundled English Hunspell dictionary, loaded lazily so the
 * extension only pays the cost when a Markdown file is actually checked. The
 * dictionary (`dictionary-en`) is ESM-only, hence the dynamic import.
 */
export class SpellEngine {
  private spell: ReturnType<typeof nspell> | null = null;
  private loading: Promise<void> | null = null;
  private failed = false;

  constructor(private readonly userDict: UserDictionary) {}

  private async ensureLoaded(): Promise<void> {
    if (this.spell || this.failed) {
      return;
    }
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const dict = (await import('dictionary-en')).default as {
            aff: Buffer;
            dic: Buffer;
          };
          const spell = nspell(dict);
          for (const word of this.userDict.all()) {
            spell.add(word);
          }
          this.spell = spell;
        } catch {
          this.failed = true;
        }
      })();
    }
    await this.loading;
  }

  async ready(): Promise<boolean> {
    await this.ensureLoaded();
    return this.spell !== null;
  }

  /** True if the token is a correctly-spelled word, a number, or user-added.
   *  Hyphenated compounds pass when every part is known. */
  isCorrect(token: string): boolean {
    if (!this.spell) {
      return true; // engine unavailable — never flag
    }
    if (/\d/.test(token)) {
      return true; // skip anything with digits
    }
    if (this.userDict.has(token)) {
      return true;
    }
    const parts = token.split('-');
    return parts.every((part) => {
      if (part.length < 2) {
        return true;
      }
      return this.spell!.correct(part) || this.spell!.correct(part.toLowerCase());
    });
  }

  suggest(word: string): string[] {
    if (!this.spell) {
      return [];
    }
    return this.spell.suggest(word).slice(0, 8);
  }

  /** Adds a word to the live engine (persistence is handled by UserDictionary). */
  add(word: string): void {
    this.spell?.add(word);
  }
}
