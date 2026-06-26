/**
 * Computes the minimal single-span replacement that turns `oldText` into
 * `newText` by trimming the common prefix and suffix. Returns the `[start, end)`
 * offsets into `oldText` to replace, plus the replacement substring of `newText`.
 *
 * For a typical keystroke this is a tiny range, so a WorkspaceEdit built from it
 * touches only the changed region instead of rewriting the whole document — which
 * keeps native undo granular and makes the edit O(change) rather than O(document).
 * Offsets are UTF-16 code-unit positions, matching VS Code's `positionAt`.
 */
export function diffRange(
  oldText: string,
  newText: string
): { start: number; end: number; replacement: string } {
  const oldLen = oldText.length;
  const newLen = newText.length;

  let start = 0;
  const maxStart = Math.min(oldLen, newLen);
  while (start < maxStart && oldText.charCodeAt(start) === newText.charCodeAt(start)) {
    start++;
  }

  let oldEnd = oldLen;
  let newEnd = newLen;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldText.charCodeAt(oldEnd - 1) === newText.charCodeAt(newEnd - 1)
  ) {
    oldEnd--;
    newEnd--;
  }

  return { start, end: oldEnd, replacement: newText.slice(start, newEnd) };
}
