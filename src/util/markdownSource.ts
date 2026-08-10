/** Keeps the Markdown *source* stable when the Pretty (WYSIWYG) editor writes a
 *  file back.
 *
 *  Toast UI holds the document as a tree, so `editor.getMarkdown()` re-serializes
 *  the WHOLE file after every edit. Its serializer has its own house style: `*`
 *  bullets, escaped punctuation in headings (`## 1\. Title`), one physical line
 *  per paragraph, `<br>` where a blank line separated blocks inside a list item.
 *  A one-sentence prose edit therefore rewrote untouched text and produced a
 *  large Git diff (GitHub issue #1).
 *
 *  {@link preserveMarkdownSource} merges the two: every block whose meaning is
 *  unchanged is written back with its ORIGINAL bytes, and only blocks the user
 *  actually changed carry serializer output (lightly normalized toward the
 *  file's own style). A block is a run of lines between blank lines.
 *
 *  Limits, by design:
 *   - The block the user edits is still serializer output, so hard wrapping
 *     inside THAT block is lost.
 *   - Blocks are matched by content, not position, so moving a block does not
 *     rewrite it.
 *   - Code fences are never normalized; indented code blocks are treated as
 *     ordinary blocks (they are preserved when unchanged, like anything else).
 */

interface Chunk {
  text: string;
  sep: string;
}

/** How the source file writes lists / line breaks, so new text matches it. */
interface SourceStyle {
  /** Dominant bullet marker (`-`, `*`, `+`), or '' when the file has no lists. */
  bullet: string;
  /** True when the file itself uses standalone `<br>` lines — then Toast's are kept. */
  keepBr: boolean;
}

const LEAD_BLANK_RE = /^(?:[ \t]*\r?\n)*/;
const BLANK_RUN_RE = /(?:\r?\n)(?:[ \t]*\r?\n)+/g;
const STANDALONE_BR_RE = /^[ \t]*<br\s*\/?>[ \t]*$/im;
const BULLET_RE = /^[ \t]*([-*+])[ \t]+/gm;
const LIST_LINE_RE = /^[ \t]*(?:[-*+]|\d+[.)])[ \t]/;
const HEADING_RE = /^[ \t]{0,3}#{1,6}[ \t]/;
const CODE_FENCE_RE = /^[ \t]*(?:```|~~~)/m;
/** Any backslash-escaped ASCII punctuation. */
const ESCAPE_RE = /\\([!-/:-@[-`{-~])/g;
/** Punctuation that never needs escaping inside a heading (no inline meaning). */
const HEADING_ESCAPE_RE = /\\([.\-+#>~=|:,;!?()"'])/g;

/** Splits text into blank-line separated blocks, keeping the leading blank lines,
 *  each block's own separator, and the trailing whitespace verbatim. */
function tokenize(text: string): { lead: string; chunks: Chunk[]; trail: string } {
  if (!text.trim()) {
    return { lead: '', chunks: [], trail: text };
  }
  const lead = LEAD_BLANK_RE.exec(text)![0];
  const trail = /\s*$/.exec(text)![0];
  const core = text.slice(lead.length, text.length - trail.length);
  const chunks: Chunk[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  BLANK_RUN_RE.lastIndex = 0;
  while ((m = BLANK_RUN_RE.exec(core))) {
    chunks.push({ text: core.slice(last, m.index), sep: m[0] });
    last = m.index + m[0].length;
  }
  chunks.push({ text: core.slice(last), sep: '' });
  return { lead, chunks, trail };
}

/** The identity of a block: what it MEANS, with everything the serializer is free
 *  to restyle removed. Two blocks with the same key are the same prose, so the
 *  original bytes can be kept.
 *
 *  Prose blocks collapse all whitespace, so re-wrapping a paragraph still matches.
 *  List blocks keep a coarse per-line indent level instead, so re-nesting a list
 *  item (an indentation-only edit the user meant) is seen as a real change. */
export function blockKey(block: string): string {
  const bare = block.replace(/<br\s*\/?>/gi, '\n').replace(ESCAPE_RE, '$1');
  const lines = bare.split(/\r?\n/);
  if (!lines.some((l) => LIST_LINE_RE.test(l))) {
    return bare.replace(/\s+/g, ' ').trim();
  }
  return lines
    .map((line) => {
      const indent = /^[ \t]*/.exec(line)![0].replace(/\t/g, '  ').length;
      const body = line
        .trim()
        .replace(/^[-*+](?=[ \t])/, '-')
        .replace(/\s+/g, ' ');
      // Half-step buckets: Toast's 4-space list continuation matches a hand-written
      // 3-space one, while a real re-nest (2 spaces per level) does not.
      return body ? Math.round(indent / 2) + ':' + body : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Reads the file's own list/break conventions off the original source. */
function sourceStyle(original: string): SourceStyle {
  const counts: Record<string, number> = { '-': 0, '*': 0, '+': 0 };
  let m: RegExpExecArray | null;
  BULLET_RE.lastIndex = 0;
  while ((m = BULLET_RE.exec(original))) {
    counts[m[1]]++;
  }
  const best = Object.keys(counts).reduce((a, b) => (counts[b] > counts[a] ? b : a), '-');
  return {
    bullet: counts[best] > 0 ? best : '',
    keepBr: STANDALONE_BR_RE.test(original)
  };
}

/** Pulls serializer output toward the file's own style. Only ever runs on blocks
 *  the user changed — untouched blocks are restored byte-for-byte instead. */
function normalizeNewBlock(text: string, style: SourceStyle): string {
  if (CODE_FENCE_RE.test(text)) {
    return text; // never touch fenced code
  }
  let out = text;
  if (!style.keepBr) {
    // Toast writes `<br>` where a blank line separated two blocks inside a list
    // item. Put the blank line back rather than delete the line, or the following
    // block becomes a lazy continuation of the first.
    out = out.replace(/^[ \t]*<br\s*\/?>[ \t]*$/gim, '');
  }
  if (style.bullet) {
    out = out.replace(/^([ \t]*)[-*+]([ \t]+)/gm, (_all, indent: string, gap: string) => indent + style.bullet + gap);
  }
  return out
    .split('\n')
    .map((line) => {
      if (HEADING_RE.test(line)) {
        return line.replace(HEADING_ESCAPE_RE, '$1');
      }
      if (/^[ \t]*\d+\\\./.test(line)) {
        return line; // unescaping here would create an ordered list
      }
      return line.replace(/(\d)\\\./g, '$1.');
    })
    .join('\n');
}

function toEol(text: string, crlf: boolean): string {
  return crlf ? text.replace(/\r?\n/g, '\r\n') : text;
}

/** Rebuilds `serialized` so that every block also present in `originalBody` keeps
 *  its original source text. Returns `serialized` unchanged when there is nothing
 *  to preserve (new or emptied document). */
export function preserveMarkdownSource(originalBody: string, serialized: string): string {
  if (!originalBody.trim() || !serialized.trim()) {
    return serialized;
  }
  const orig = tokenize(originalBody);
  const ser = tokenize(serialized);
  const style = sourceStyle(originalBody);
  const crlf = /\r\n/.test(originalBody) && !/\r\n/.test(serialized);

  // Unused original blocks by key. Repeated identical blocks are consumed in
  // order; which one a match takes is irrelevant, since they mean the same thing.
  const pool = new Map<string, number[]>();
  orig.chunks.forEach((c, i) => {
    const key = blockKey(c.text);
    const slot = pool.get(key);
    if (slot) {
      slot.push(i);
    } else {
      pool.set(key, [i]);
    }
  });

  const parts = ser.chunks.map((chunk, i) => {
    const slot = pool.get(blockKey(chunk.text));
    const match = slot && slot.length ? slot.shift()! : -1;
    const text = match >= 0 ? orig.chunks[match].text : toEol(normalizeNewBlock(chunk.text, style), crlf);
    const last = i === ser.chunks.length - 1;
    const sep = last ? '' : match >= 0 ? orig.chunks[match].sep || chunk.sep : chunk.sep;
    return text + toEol(sep, crlf);
  });
  return orig.lead + parts.join('') + orig.trail;
}
