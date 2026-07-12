/**
 * Mechanical grammar via Harper (https://writewithharper.com) — a local, offline,
 * Rust/WASM grammar engine. It replaces the small local LLM as the grammar source:
 * the model is good at context spelling but invents subjective "errors" (preposition
 * / idiom / word-choice), while Harper is deterministic and high-precision.
 *
 * Harper is ESM + WASM and the extension host is a CommonJS esbuild bundle, so we load
 * it LAZILY via a runtime dynamic import (variable specifiers, so esbuild leaves them
 * as real `import()` calls instead of trying to bundle 17 MB of WASM). We use the
 * `binaryInlined` entry — the WASM is embedded in the JS, so there is no separate
 * `.wasm` file to resolve in the packaged host (the failure mode that has bitten ESM
 * data deps here before). If the load fails we record the error and return no findings
 * — grammar simply goes quiet, the editor keeps working; it never fails silently.
 */
/** A grammar / word-choice error to underline (different color from spelling).
 *  Harper is the sole producer; the editor anchors the underline by `phrase`. */
export interface GrammarIssue {
  /** The exact wrong text in the paragraph (used to anchor the underline). */
  phrase: string;
  /** Short human reason (Harper's message, e.g. "Did you mean `they're`?"). */
  message: string;
  /** The corrected replacement for `phrase`. */
  fix: string;
}

interface HarperSpan {
  start: number;
  end: number;
}
interface HarperSuggestion {
  kind(): number; // Harper SuggestionKind: 0 = replace, 1 = remove, 2 = insert after the span
  get_replacement_text(): string;
}
interface HarperLint {
  span(): HarperSpan;
  message(): string;
  lint_kind(): string;
  suggestion_count(): number;
  suggestions(): HarperSuggestion[];
}
interface HarperLinter {
  setup(): Promise<void>;
  lint(text: string): Promise<HarperLint[]>;
  /** Partial rule on/off map as JSON, merged over Harper's defaults. Used to silence
   *  rules that misfire on fiction (see {@link FICTION_RULE_CONFIG}). */
  setLintConfigWithJSON(config: string): Promise<void>;
}

/** Harper rules turned OFF for fiction prose — its native, rule-level mechanism (cleaner
 *  and more precise than post-filtering by message). Verified against real chapters: these
 *  are the clear false-positive generators in creative writing. High-precision grammar
 *  (subject/verb agreement, homophones like to/too, repetition) stays ON. Stylistic rules
 *  the author chose to keep (SentenceCapitalization, CompoundNouns, NumericRangeEnDash)
 *  are deliberately NOT here. Rule keys come from Harper's getLintDescriptions. */
const FICTION_RULE_CONFIG: Record<string, boolean> = {
  UnclosedQuotes: false, // fires on multi-paragraph / interrupted dialogue — the #1 noise source
  AnA: false, // "a"/"an" misfires on coined & proper nouns ("a Eelan" → "an Eelan")
  LetsConfusion: false, // "lets" (a normal verb) wrongly pushed to "let's"
  EllipsisLength: false, // the manuscript intentionally uses "..."
  UseEllipsisCharacter: false, // …and doesn't want it auto-converted to "…"
  AvoidCurses: false, // profanity is in scope for fiction; not the editor's business
  PronounContraction: false, // pushes ordinary past-tense "were" to "we're" ("they were reading" → "they we're")
  MassNouns: false, // fiction nominalizes freely — "a burning on her back", "a knowing" are intentional
  MissingTo: false // mis-parses participial adjectives as verbs ("their intended use" → wants "intended to")
};

/** Lint kinds we do NOT surface as grammar underlines. Spelling is owned by the
 *  dictionary + AI-spell pipeline; the rest are stylistic, which we keep off to hold
 *  the conservative "only clear mechanical errors" bar. `Typo` is excluded because it
 *  is Harper's "split an unknown word into two known words" heuristic — it misfires on
 *  closed compounds ("streetwear" → "street wear") and dropped-g dialect ("lookin'" →
 *  "loo kin"), which are everywhere in fiction; genuine misspellings come back as
 *  `Spelling` (owned by the dictionary), real merges as `BoundaryError`, and doubled
 *  words as `Repetition`, so nothing useful is lost. `WordChoice` is intentionally NOT
 *  excluded — it carries Harper's vetted homophone/confusable catches (e.g. to/too) and
 *  tested clean on realistic fiction prose (see test/homophone.test.ts). Everything else
 *  (Agreement, Grammar, Repetition, Capitalization, Punctuation, BoundaryError, …) shows. */
const EXCLUDED_KINDS = new Set([
  'Spelling',
  'Typo',
  'Style',
  'Enhancement',
  'Readability',
  'Redundancy',
  'Usage'
]);

let linterPromise: Promise<HarperLinter | null> | undefined;
let loadError: string | undefined;

async function getLinter(): Promise<HarperLinter | null> {
  if (!linterPromise) {
    linterPromise = (async () => {
      try {
        // Variable specifiers: keep these as runtime ESM dynamic imports (not bundled).
        const harperSpec = 'harper.js';
        const binarySpec = 'harper.js/binaryInlined';
        const harper = (await import(harperSpec)) as {
          LocalLinter: new (opts: { binary: unknown; dialect: unknown }) => HarperLinter;
          Dialect: { American: unknown };
        };
        // `binaryInlined` embeds the WASM as a data: URL — no separate .wasm file to
        // resolve in the packaged host (the path-resolution failure mode we avoid).
        const { binaryInlined } = (await import(binarySpec)) as { binaryInlined: unknown };
        const linter = new harper.LocalLinter({ binary: binaryInlined, dialect: harper.Dialect.American });
        await linter.setup();
        // Apply the fiction-tuned rule config at the source. Isolated try/catch: if a future
        // harper.js renames the config API, grammar keeps working with default rules rather
        // than going silent.
        try {
          await linter.setLintConfigWithJSON(JSON.stringify(FICTION_RULE_CONFIG));
        } catch {
          /* config API unavailable — fall back to Harper's defaults */
        }
        return linter;
      } catch (err) {
        loadError = err instanceof Error ? err.message : String(err);
        return null;
      }
    })();
  }
  return linterPromise;
}

/** The Harper load failure, if any — so the caller can surface a one-time notice. */
export function harperLoadError(): string | undefined {
  return loadError;
}

/** Walks back from `start` over whitespace then one word, returning that word's start
 *  offset (or `start` when the span begins the text). Used to give a single-token fix
 *  enough context to anchor uniquely in the paragraph (the webview matches by text). */
function precedingWordStart(text: string, start: number): number {
  let i = start;
  while (i > 0 && /\s/.test(text[i - 1])) {
    i--;
  }
  while (i > 0 && /[\p{L}\p{N}’'-]/u.test(text[i - 1])) {
    i--;
  }
  return i;
}

/** True when the token at `start` genuinely begins a sentence — it follows the start
 *  of the text, a line break, or terminal punctuation (`.`/`!`/`?`/`…`, optionally
 *  through a closing quote/bracket). Harper's capitalization linter mis-segments
 *  comma-spliced run-ons and prose with unknown lowercase words, tagging a mid-
 *  sentence word (e.g. "but" after "…, ") as a sentence start; this rejects those
 *  while keeping real lowercase sentence starts (after a period or a paragraph break). */
function startsSentence(text: string, start: number): boolean {
  let i = start - 1;
  while (i >= 0 && (text[i] === ' ' || text[i] === '\t')) {
    i--;
  }
  if (i < 0 || text[i] === '\n' || text[i] === '\r') {
    return true; // start of text, or a new line / paragraph
  }
  while (i >= 0 && '"\'”’)]'.includes(text[i])) {
    i--; // skip closing quotes/brackets so `."` and `.)` still count as a boundary
  }
  return i < 0 || '.!?…'.includes(text[i]);
}

/**
 * Lints `text` with Harper and maps findings to the editor's {@link GrammarIssue}
 * shape (anchored by problem text, like the AI grammar pass it replaces). A
 * single-token replacement is expanded with its preceding word so a short fix like
 * "was → were" can't anchor on the wrong occurrence. Returns [] when Harper is
 * unavailable.
 */
export async function harperGrammar(text: string): Promise<GrammarIssue[]> {
  const linter = await getLinter();
  if (!linter) {
    return [];
  }
  let lints: HarperLint[];
  try {
    lints = await linter.lint(text);
  } catch {
    return [];
  }
  return mapHarperLints(text, lints);
}

/** The lint→issue mapping, separated from the linter lifecycle so the suggestion-kind
 *  handling (replace / remove / insert-after) is unit-testable with stub lints. */
export function mapHarperLints(text: string, lints: HarperLint[]): GrammarIssue[] {
  const out: GrammarIssue[] = [];
  const seen = new Set<string>();
  for (const lint of lints) {
    if (EXCLUDED_KINDS.has(lint.lint_kind())) {
      continue;
    }
    if (lint.suggestion_count() === 0) {
      continue; // nothing actionable — don't underline what we can't one-click fix
    }
    const span = lint.span();
    // Harper's sentence-capitalization linter mis-fires on comma-spliced run-ons,
    // flagging a mid-sentence word as needing a capital. Keep it only when the word
    // truly starts a sentence; otherwise drop the false positive.
    if (lint.lint_kind() === 'Capitalization' && !startsSentence(text, span.start)) {
      continue;
    }
    const raw = text.slice(span.start, span.end);
    if (!raw.trim()) {
      continue;
    }
    const sug = lint.suggestions()[0];
    let phrase: string;
    let fix: string;
    if (sug.kind() === 1) {
      // Removal (e.g. a stray repeated word) — delete the span.
      phrase = raw.trim();
      fix = '';
    } else {
      // Insert-after (kind 2) keeps the span and appends the suggestion text after it,
      // exactly as Harper applies it. Treating it as a replacement — the old behavior —
      // DELETED the flagged word ("their intended" → "their to"). Kind 0 is a plain
      // replacement of the span.
      const sugText = sug.get_replacement_text();
      const replacement = sug.kind() === 2 ? raw + sugText : sugText;
      if (/^\S+$/.test(raw.trim())) {
        // Single token — expand with the preceding word for a unique anchor.
        const ctxStart = precedingWordStart(text, span.start);
        const prefix = text.slice(ctxStart, span.start);
        phrase = (prefix + raw).trim();
        fix = (prefix + replacement).trim();
      } else {
        phrase = raw.trim();
        fix = replacement;
      }
    }
    if (!phrase || phrase === fix) {
      continue;
    }
    const key = `${phrase}→${fix}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ phrase, message: lint.message(), fix });
  }
  return out;
}
