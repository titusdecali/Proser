/**
 * Per-chapter Proser metadata stored as an invisible HTML comment at the top of the
 * file. Today it carries only a narrative-tense override. The comment travels in the
 * document text (not external state), so it survives file renames and is shareable;
 * the Markdown source view shows it, while the Pretty (WYSIWYG) view peels it into a
 * hidden "head" (see proseText.ts `splitHead`) and re-emits it on save.
 *
 * Shared by the host (analysis passes) and the webview (round-trip + the clock UI),
 * so it lives in util/ rather than the webview-only proseText.ts.
 */

/** The narrative tense a chapter may pin instead of the auto-detected default. */
export type TenseOverride = 'past' | 'present' | 'future';

/** Matches the tense-override comment wherever it appears (used to read the value).
 *  Tense-specific: only the three valid values match, so a typo'd value reads as Auto. */
export const TENSE_COMMENT_RE = /<!--\s*proser:tense=(past|present|future)\s*-->/i;

/** Any Proser metadata comment line (`<!-- proser:key=value -->`) with its trailing
 *  newline, anchored to a line start. Generic (not tense-only) so it stays in step
 *  with proseText.ts `splitHead`: every comment the editor hides is also stripped
 *  before analysis. Global + multiline for replace-all across the document. */
export const PROSER_META_LINE_RE = /^[ \t]*<!--\s*proser:[a-z]+=[^>]*?-->[ \t]*\r?\n?/gim;

/** The chapter's tense override, or null when none is set (Auto / global default). */
export function readTenseOverride(text: string): TenseOverride | null {
  const m = TENSE_COMMENT_RE.exec(text);
  return m ? (m[1].toLowerCase() as TenseOverride) : null;
}

/** The metadata comment line for `tense` (with trailing newline), or '' for Auto. */
export function formatTenseComment(tense: TenseOverride | null): string {
  return tense ? `<!-- proser:tense=${tense} -->\n` : '';
}

/** Strips Proser metadata comment line(s) so checks and word counts never see them. */
export function stripProserMeta(text: string): string {
  return text.replace(PROSER_META_LINE_RE, '');
}
