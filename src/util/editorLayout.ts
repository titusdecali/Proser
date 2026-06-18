import * as vscode from 'vscode';

/** Sizes a freshly-opened side panel (the right group of a simple two-group
 *  split) to an approximate pixel width.
 *
 *  VS Code only sizes editor groups *proportionally* — there's no pixel API — so
 *  we infer the real editor-area width from the panel's reported inner width.
 *  A panel opened with `ViewColumn.Beside` next to a single editor lands at a
 *  50/50 split, so the total editor area ≈ 2× the panel's inner width. We then
 *  re-apply the layout with the file group taking `total − targetPx` and the
 *  panel taking `targetPx`; because that sum equals the real width, the panel
 *  ends up ≈ `targetPx` on any screen. */
export function sizeSidePanel(innerWidth: number, targetPx: number): void {
  if (vscode.window.tabGroups.all.length !== 2) {
    return; // only a plain file | panel split — don't flatten complex layouts
  }
  const total = Math.round(innerWidth * 2); // panel was ~half of the editor area
  if (!Number.isFinite(total) || total <= targetPx + 50) {
    return; // implausible / not enough room — leave the default 50/50
  }
  void vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 0,
    groups: [{ size: total - targetPx }, { size: targetPx }]
  });
}
