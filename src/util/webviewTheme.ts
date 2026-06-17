/**
 * Proser's shared webview palette — the neon accent trio used for suggestion
 * options (synonyms / spelling / revise) and the Editor-check color coding.
 *
 * Each VS Code webview is an isolated iframe, so these custom properties must be
 * *declared* inside every webview's stylesheet — but the VALUES live ONLY here.
 * Inject with `:root { ${PROSER_THEME_VARS} }` (or inside any rule).
 */
export const PROSER_THEME_VARS =
  '--proser-opt-1:#39ff14;' + // neon green
  '--proser-opt-2:#ff2d95;' + // neon pink
  '--proser-opt-3:#b026ff;'; // neon purple
