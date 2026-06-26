import * as vscode from 'vscode';
import { ConfigKeys, EXTENSION_ID, STATE_SPELL_IGNORED, STATE_GRAMMAR_IGNORED } from '../../constants';
import { getProseTokens } from '../../util/wordcount';
import { ScanOptions } from '../../util/markdownScan';
import { UserDictionary } from './userDictionary';
import { SpellEngine } from './spellEngine';
import { loadDictionary } from './dictionaries';

const MAX_RESULTS = 1000;
const MAX_DOC_SIZE = 500_000; // characters; skip spell check on very large files

export interface Misspelling {
  word: string;
  suggestions: string[];
}

/**
 * Shared, language-aware spelling brain: one engine + user dictionary, reused by
 * the Pretty editor's inline squiggles and the Spelling sidebar. The active
 * language comes from `proser.spellcheck.language`; English is built in, other
 * languages are downloaded and cached on first use.
 */
export class SpellService {
  private readonly userDict: UserDictionary;
  private readonly ignored: Set<string>;
  private readonly ignoredGrammar: Set<string>;
  private engine?: SpellEngine;
  private language: string;
  private loading?: Promise<SpellEngine | undefined>;
  private readonly changeEmitter = new vscode.EventEmitter<void>();

  /** Fires when results may have changed: dictionary add, the enabled toggle, or
   *  a language switch. Surfaces re-pull on this. */
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.userDict = new UserDictionary(context);
    this.ignored = new Set(
      context.workspaceState.get<string[]>(STATE_SPELL_IGNORED, []).map((w) => w.toLowerCase())
    );
    this.ignoredGrammar = new Set(
      context.workspaceState.get<string[]>(STATE_GRAMMAR_IGNORED, []).map((p) => p.toLowerCase())
    );
    this.language = this.configuredLanguage();
    context.subscriptions.push(
      this.changeEmitter,
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${EXTENSION_ID}.spellcheck`)) {
          const next = this.configuredLanguage();
          if (next !== this.language) {
            this.language = next;
            this.engine = undefined; // force a reload (downloads if needed)
          }
          this.changeEmitter.fire();
        }
      })
    );
  }

  get currentLanguage(): string {
    return this.language;
  }

  enabled(): boolean {
    return vscode.workspace
      .getConfiguration(EXTENSION_ID)
      .get<boolean>(ConfigKeys.spellcheckEnabled, true);
  }

  private configuredLanguage(): string {
    return (
      vscode.workspace
        .getConfiguration(EXTENSION_ID)
        .get<string>(ConfigKeys.spellcheckLanguage, 'en') || 'en'
    );
  }

  async ready(): Promise<boolean> {
    const eng = await this.ensureEngine();
    return !!eng?.ready;
  }

  /** Loads (and caches) the engine for the active language, deduping concurrent
   *  loads and ignoring a result if the language changed again mid-download. */
  private ensureEngine(): Promise<SpellEngine | undefined> {
    if (this.engine && this.engine.language === this.language) {
      return Promise.resolve(this.engine);
    }
    if (!this.loading) {
      const lang = this.language;
      this.loading = (async () => {
        const dicts = await loadDictionary(this.context, lang);
        const eng = new SpellEngine(this.userDict, lang);
        if (dicts) {
          eng.load(dicts);
        }
        if (this.language === lang) {
          this.engine = eng;
        }
        return this.engine;
      })().finally(() => {
        this.loading = undefined;
      });
    }
    return this.loading;
  }

  /**
   * Unique misspelled words in `text` (original casing preserved) with a few
   * suggestions each. Empty when spell check is off, the engine isn't available
   * (e.g. a dictionary download failed), or the document is too large. The
   * capitalization-based proper-noun skip runs for English only.
   */
  async misspellings(text: string): Promise<Misspelling[]> {
    if (!this.enabled() || text.length > MAX_DOC_SIZE) {
      return [];
    }
    const eng = await this.ensureEngine();
    if (!eng || !eng.ready) {
      return [];
    }
    const opts: ScanOptions = {};
    const english = eng.language === 'en';
    const tokens = getProseTokens(text, opts);

    // Confident proper nouns: words seen capitalized (non-ALL-CAPS) mid-sentence
    // at least once. We then skip them everywhere — so a recurring name like
    // "Theo" isn't flagged when it happens to start a sentence. A typo like "Teh"
    // never appears capitalized mid-sentence, so it stays flagged. English only.
    const properNouns = new Set<string>();
    if (english) {
      for (const t of tokens) {
        if (
          /^\p{Lu}/u.test(t.word) &&
          t.word !== t.word.toUpperCase() &&
          !isSentenceStart(text, t.start)
        ) {
          properNouns.add(t.word);
        }
      }
    }

    const seen = new Set<string>();
    const out: Misspelling[] = [];
    for (const token of tokens) {
      if (seen.has(token.word) || eng.isCorrect(token.word) || this.ignored.has(token.word.toLowerCase())) {
        continue;
      }
      if (english && (properNouns.has(token.word) || isProperNoun(token.word, text, token.start))) {
        continue;
      }
      seen.add(token.word);
      out.push({ word: token.word, suggestions: eng.suggest(token.word) });
      if (out.length >= MAX_RESULTS) {
        break;
      }
    }
    return out;
  }

  /** True if the active dictionary accepts `word` (engine unavailable → true, so
   *  callers never over-reject). Used to validate AI-proposed spelling
   *  corrections — keep only the ones that are genuinely real words. */
  async isWordCorrect(word: string): Promise<boolean> {
    const eng = await this.ensureEngine();
    return !eng || !eng.ready ? true : eng.isCorrect(word);
  }

  /** Adds a word to the personal dictionary and live engine, then notifies. */
  async add(word: string): Promise<void> {
    if (!word) {
      return;
    }
    await this.userDict.add(word);
    const eng = await this.ensureEngine();
    eng?.add(word);
    this.changeEmitter.fire();
  }

  /** Suppresses a misspelling from the list and inline squiggles WITHOUT adding it
   *  to the dictionary (persisted per workspace). */
  async ignore(word: string): Promise<void> {
    const key = (word || '').toLowerCase();
    if (!key || this.ignored.has(key)) {
      return;
    }
    this.ignored.add(key);
    await this.context.workspaceState.update(STATE_SPELL_IGNORED, [...this.ignored]);
    this.changeEmitter.fire();
  }

  /** Whether a grammar/word-choice finding (keyed by its flagged phrase) has been
   *  ignored in this workspace. */
  isGrammarIgnored(phrase: string): boolean {
    return this.ignoredGrammar.has((phrase || '').trim().toLowerCase());
  }

  /** Permanently suppresses a grammar/word-choice finding by its phrase (persisted
   *  per workspace). Does NOT fire onDidChange — the caller re-posts directly to
   *  avoid a full AI re-scan. */
  async ignoreGrammar(phrase: string): Promise<void> {
    const key = (phrase || '').trim().toLowerCase();
    if (!key || this.ignoredGrammar.has(key)) {
      return;
    }
    this.ignoredGrammar.add(key);
    await this.context.workspaceState.update(STATE_GRAMMAR_IGNORED, [...this.ignoredGrammar]);
  }
}

/** Initial-uppercase (but not ALL-CAPS) word that isn't sentence-initial — i.e.
 *  a proper noun in running prose, which we leave unflagged. English heuristic. */
function isProperNoun(word: string, text: string, start: number): boolean {
  if (!/^\p{Lu}/u.test(word) || word === word.toUpperCase()) {
    return false;
  }
  return !isSentenceStart(text, start);
}

/** Whether the offset begins a sentence (start of text, after a line break, or
 *  after sentence-ending punctuation), skipping spaces and opening quotes. */
function isSentenceStart(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t' || /["'“‘(\[]/u.test(text[i]))) {
    i--;
  }
  if (i < 0) {
    return true;
  }
  const c = text[i];
  return c === '\n' || c === '\r' || c === '.' || c === '!' || c === '?' || c === ':' || c === ';';
}
