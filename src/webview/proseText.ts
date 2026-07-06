/** Pure text helpers for the Pretty editor, kept out of main.ts so the markdown
 *  normalization rules live on their own and can be reasoned about in isolation. */

/** Split YAML frontmatter off the top so Toast UI never round-trips (and
 *  mangles) it. The frontmatter is preserved byte-for-byte. */
export function splitFrontmatter(text: string): { fm: string; body: string } {
  const m = /^(---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)/.exec(text);
  return m ? { fm: m[1], body: text.slice(m[1].length) } : { fm: '', body: text };
}

const FRONTMATTER_HEAD_RE = /^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/;
const PROSER_META_HEAD_RE = /^[ \t]*<!--\s*proser:[a-z]+=[^>]*?-->[ \t]*\r?\n?/i;

/** Splits the hidden "head" — YAML frontmatter and/or a leading Proser metadata
 *  comment (e.g. `<!-- proser:tense=present -->`), in any order — off the top so the
 *  Pretty view renders only the body and never mangles either. Both are preserved
 *  byte-for-byte and re-emitted by {@link joinHead}. */
export function splitHead(text: string): { frontmatter: string; proserMeta: string; body: string } {
  // Frontmatter is only valid at the very top (YAML must lead the file), so peel it
  // FIRST and only there, THEN a leading Proser comment. We deliberately do NOT look
  // for frontmatter *after* a comment: a body that opens with a `---…---` thematic
  // break would otherwise be misread as frontmatter and vanish from the Pretty view.
  let rest = text;
  let frontmatter = '';
  const fm = FRONTMATTER_HEAD_RE.exec(rest);
  if (fm) {
    frontmatter = fm[0];
    rest = rest.slice(fm[0].length);
  }
  let proserMeta = '';
  const pm = PROSER_META_HEAD_RE.exec(rest);
  if (pm) {
    proserMeta = pm[0];
    rest = rest.slice(pm[0].length);
  }
  return { frontmatter, proserMeta, body: rest };
}

/** Reassembles a document from its split head + body: frontmatter first (YAML must
 *  lead the file), then the Proser metadata comment, then the editable body. */
export function joinHead(frontmatter: string, proserMeta: string, body: string): string {
  return frontmatter + proserMeta + body;
}

/** Toast UI's WYSIWYG conversion blanks the whole document on an *inline* HTML
 *  comment (one mid-paragraph), and an *unterminated* comment (`<!--` with no
 *  closing `-->`) makes it swallow the entire rest of the document — so the
 *  chapter looks blank/uneditable even though the text is on disk. Block-level,
 *  terminated comments (their own line) render fine, so normalize toward that:
 *  isolate inline `<!-- … -->` onto their own block, and close any dangling
 *  comment at the end of its own paragraph. Idempotent for already-block,
 *  already-terminated comments. (Plain regex — doesn't skip fenced code, which
 *  prose effectively never contains.) */
export function blockifyComments(md: string): string {
  let out = md.replace(/[ \t]*<!--[\s\S]*?-->[ \t]*/g, (match, offset: number, str: string) => {
    // Only the truly-inline case (prose *before* the comment on the same line)
    // breaks Toast UI. Comments already at line-start render fine — leave them and
    // their trailing same-line prose untouched so working chapters aren't reflowed.
    if (offset === 0 || str[offset - 1] === '\n') {
      return match;
    }
    const end = offset + match.length;
    const atLineEnd = end >= str.length || str[end] === '\n';
    return '\n\n' + match.trim() + (atLineEnd ? '' : '\n\n');
  });
  // The pass above consumes every *terminated* comment, so a remaining `<!--`
  // with no `-->` after it is the dangling one. Close it at the end of its own
  // paragraph (next blank line) so ONLY the note is hidden — not the prose that
  // follows it — falling back to end-of-file when it's the last paragraph.
  const open = out.lastIndexOf('<!--');
  if (open !== -1 && out.indexOf('-->', open) === -1) {
    const para = out.indexOf('\n\n', open);
    out =
      para !== -1
        ? out.slice(0, para) + ' -->' + out.slice(para)
        : out.replace(/\s*$/, '') + ' -->';
  }
  return out;
}
