/**
 * The single source of truth for "which parts of a Markdown document are
 * prose". Both word count and spell check consume it, so the rules for what to
 * skip (YAML frontmatter, fenced/inline code, URLs) live here only.
 *
 * The scanner returns absolute character spans into the original text, so
 * callers can both count words and map token offsets back to document
 * positions without re-deriving the exclusions.
 */

export interface ProseSpan {
  start: number;
  end: number;
}

export interface ScanOptions {
  includeCodeBlocks?: boolean;
  includeFrontmatter?: boolean;
}

export const FENCE_RE = /^\s*(```|~~~)/;
const FRONTMATTER_DELIM_RE = /^---\s*$/;

/** Matches markdown link/image targets, bare URLs, and autolinks so their
 *  non-word URL contents are excluded while visible link text is kept. */
const URL_LIKE_RE = /\]\(([^)]*)\)|<https?:\/\/[^>]*>|\bhttps?:\/\/\S+/giu;

/** Inline code spans delimited by equal-length backtick runs. Hoisted to
 *  module scope so it isn't recompiled for every prose line. */
const INLINE_CODE_RE = /(`+)([^`]|[^`].*?[^`])\1(?!`)/gs;

/**
 * Returns the prose spans of a Markdown document.
 *
 * Lines inside YAML frontmatter or fenced code blocks are excluded wholesale
 * (unless the matching option opts them in). Within prose lines, inline code
 * spans and URL-like runs are punched out, keeping visible link text.
 */
export function getProseSpans(text: string, options: ScanOptions = {}): ProseSpan[] {
  const includeCode = options.includeCodeBlocks ?? false;
  const includeFrontmatter = options.includeFrontmatter ?? false;

  const spans: ProseSpan[] = [];
  let offset = 0;
  let inFrontmatter = false;
  let frontmatterChecked = false;
  let fence: string | null = null;

  const lines = text.split('\n');

  // Only treat a leading `---` as frontmatter when a closing `---` exists;
  // otherwise an unmatched divider would swallow the whole document.
  const hasFrontmatterCloser =
    lines.length > 1 &&
    FRONTMATTER_DELIM_RE.test(lines[0]) &&
    lines.slice(1).some((l) => FRONTMATTER_DELIM_RE.test(l));

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineStart = offset;
    // Advance offset past this line plus its newline for the next iteration.
    offset += line.length + 1;

    // Frontmatter only counts if the very first line opens it.
    if (!frontmatterChecked) {
      frontmatterChecked = true;
      if (i === 0 && hasFrontmatterCloser) {
        inFrontmatter = true;
        continue;
      }
    }
    if (inFrontmatter) {
      if (FRONTMATTER_DELIM_RE.test(line)) {
        inFrontmatter = false;
      }
      if (!includeFrontmatter) {
        continue;
      }
    }

    // Fenced code blocks: the fence lines and their contents are code.
    const fenceMatch = FENCE_RE.exec(line);
    if (fence !== null) {
      // Inside a fence; the closing fence line is still code.
      if (fenceMatch && line.includes(fence)) {
        fence = null;
      }
      if (!includeCode) {
        continue;
      }
    } else if (fenceMatch) {
      fence = fenceMatch[1];
      if (!includeCode) {
        continue;
      }
    }

    addLineSpans(line, lineStart, includeCode, spans);
  }

  return spans;
}

/** Splits one prose line into spans, punching out inline code and URLs. */
function addLineSpans(
  line: string,
  lineStart: number,
  includeCode: boolean,
  out: ProseSpan[]
): void {
  // Mark excluded character ranges (relative to the line).
  const excluded: Array<[number, number]> = [];

  if (!includeCode) {
    // Inline code: spans delimited by runs of backticks of equal length.
    let m: RegExpExecArray | null;
    INLINE_CODE_RE.lastIndex = 0;
    while ((m = INLINE_CODE_RE.exec(line)) !== null) {
      excluded.push([m.index, m.index + m[0].length]);
    }
  }

  let u: RegExpExecArray | null;
  URL_LIKE_RE.lastIndex = 0;
  while ((u = URL_LIKE_RE.exec(line)) !== null) {
    if (u[1] !== undefined) {
      // `](url)` — exclude just the (url) portion, keep the link text.
      const parenStart = u.index + u[0].indexOf('(');
      excluded.push([parenStart, u.index + u[0].length]);
    } else {
      excluded.push([u.index, u.index + u[0].length]);
    }
  }

  if (excluded.length === 0) {
    if (line.length > 0) {
      out.push({ start: lineStart, end: lineStart + line.length });
    }
    return;
  }

  excluded.sort((a, b) => a[0] - b[0]);
  let cursor = 0;
  for (const [exStart, exEnd] of excluded) {
    if (exStart > cursor) {
      out.push({ start: lineStart + cursor, end: lineStart + exStart });
    }
    cursor = Math.max(cursor, exEnd);
  }
  if (cursor < line.length) {
    out.push({ start: lineStart + cursor, end: lineStart + line.length });
  }
}
