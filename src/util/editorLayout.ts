import * as vscode from 'vscode';

/**
 * Sizes the Proser side panels (Editor checks / Brainstorm) to an approximate
 * pixel width when opened `Beside` a file in a simple two-group split.
 *
 * VS Code has no pixel layout API — only *proportional* group sizes — and no way
 * to read the editor-area width up front. So we remember the real editor width
 * (derived from the panel's reported inner width) and **pre-apply** the target
 * layout the instant the panel opens, before its webview paints. That avoids the
 * old open-at-50%-then-resize flicker: the panel renders at the target size from
 * the first frame. The first-ever open (no remembered width) still falls back to
 * the measure round-trip, then caches the width for every open after.
 */
const WIDTH_KEY = 'proser.sidePanel.editorTotalWidth';

/** Whether we're in the plain `file | panel` split this sizing is safe for. */
function isTwoGroupSplit(): boolean {
  return vscode.window.tabGroups.all.length === 2;
}

/** Re-apply the editor layout so the side (second) group is ~`targetPx` wide. */
function applyLayout(totalWidth: number, targetPx: number): void {
  void vscode.commands.executeCommand('vscode.setEditorLayout', {
    orientation: 0,
    groups: [{ size: totalWidth - targetPx }, { size: targetPx }]
  });
}

/**
 * Pre-sizes a just-opened side panel from the remembered editor-area width, so it
 * opens at ~`targetPx` with no resize flicker. Call synchronously right after
 * `createWebviewPanel`. Returns true when it applied (so {@link recordSidePanel}
 * knows the panel did NOT open at the 50/50 default).
 */
export function presizeSidePanel(state: vscode.Memento, targetPx: number): boolean {
  if (!isTwoGroupSplit()) {
    return false;
  }
  const total = state.get<number>(WIDTH_KEY, 0);
  if (total > targetPx + 50) {
    applyLayout(total, targetPx);
    return true;
  }
  return false; // no remembered width yet — recordSidePanel will size on measure
}

/**
 * Refines the remembered editor-area width from the panel's reported inner width,
 * and re-sizes only when needed (the first-ever open, or when the editor area
 * changed enough that the pre-sized panel missed its target — e.g. a window or
 * monitor resize). `preApplied` is the return value of {@link presizeSidePanel}.
 */
export async function recordSidePanel(
  state: vscode.Memento,
  innerWidth: number,
  targetPx: number,
  preApplied: boolean
): Promise<void> {
  if (!isTwoGroupSplit() || !Number.isFinite(innerWidth) || innerWidth <= 0) {
    return;
  }
  const cached = state.get<number>(WIDTH_KEY, 0);
  // When we pre-applied, the panel is `targetPx` of `cached`, so the real width is
  // innerWidth × cached / targetPx. Otherwise the panel opened at the 50/50
  // default, so the editor area is ≈ 2× the panel's inner width.
  const total =
    preApplied && cached > 0
      ? Math.round((innerWidth * cached) / targetPx)
      : Math.round(innerWidth * 2);
  if (total <= targetPx + 50) {
    return; // implausible / not enough room — leave the default split
  }
  if (total !== cached) {
    await state.update(WIDTH_KEY, total);
  }
  // Size on the first open, or correct a meaningful drift after a window resize.
  if (!preApplied || Math.abs(total - cached) > 60) {
    applyLayout(total, targetPx);
  }
}
