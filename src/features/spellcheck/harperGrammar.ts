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
import { GrammarIssue } from './aiSpell';

interface HarperSpan {
  start: number;
  end: number;
}
interface HarperSuggestion {
  kind(): number; // 1 = remove, otherwise replace
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
}

/** Lint kinds we do NOT surface as grammar underlines. Spelling is owned by the
 *  dictionary + AI-spell pipeline; the rest are stylistic, which we keep off to hold
 *  the conservative "only clear mechanical errors" bar. Everything else (Agreement,
 *  Grammar, Repetition, Capitalization, Punctuation, Eggcorn, Malapropism, …) shows. */
const EXCLUDED_KINDS = new Set([
  'Spelling',
  'Style',
  'Enhancement',
  'Readability',
  'Redundancy',
  'WordChoice',
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
      const replacement = sug.get_replacement_text();
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
