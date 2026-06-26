/**
 * The host ↔ webview message contract for the Pretty (WYSIWYG) editor, in ONE
 * place so the `type` strings can't drift between sender and receiver. These are
 * the discriminators carried on every `postMessage({ type, … })`.
 *
 * NOTE: src/webview is intentionally excluded from `tsc` (it targets the DOM and
 * is bundled by esbuild, which strips types), so these unions document and guide
 * rather than hard-enforce. Keep them in sync when adding a message.
 */

/** Messages the extension host sends DOWN to the editor webview. */
export type HostToWebviewType =
  | 'update'
  | 'reveal'
  | 'insertHr'
  | 'insertText'
  | 'replaceSelection'
  | 'thesaurusResult'
  | 'reviseResult'
  | 'promptsResult'
  | 'doQuickPdf'
  | 'spellResult'
  | 'passiveResult'
  | 'tenseResult'
  | 'spellAiResult'
  | 'stats'
  | 'aiStatus'
  | 'aiBusy'
  | 'aiModelState'
  | 'config';

/** Messages the editor webview sends UP to the extension host. */
export type WebviewToHostType =
  | 'ready'
  | 'displayed'
  | 'edit'
  | 'save'
  | 'toggleSpellcheck'
  | 'setFontSize'
  | 'exportPdf'
  | 'exportError'
  | 'doQuickPdf'
  | 'definitionRequest'
  | 'thesaurusEngine'
  | 'selectModel'
  | 'spellAiSuggest'
  | 'addToDictionary'
  | 'ignoreWord'
  | 'ignoreGrammar'
  | 'showIssues'
  | 'openBrainstorm'
  | 'exportMenu'
  | 'promptsLoad'
  | 'promptsSave';
