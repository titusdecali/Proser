import * as vscode from 'vscode';
import { getNonce } from '../../util/nonce';
import { PROSER_THEME_VARS } from '../../util/webviewTheme';

/** Builds the webview HTML with a strict CSP. Scripts run only under the nonce;
 *  styles come from the bundled CSS plus inline (Toast UI injects some). */
export function getEditorHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'webview.css')
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data: blob:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <style nonce="${nonce}">
    :root { ${PROSER_THEME_VARS} }
    html, body { height: 100%; margin: 0; padding: 0; overflow: hidden;
      /* Barely-visible edge: the theme's panel border at ~30% opacity, used for
         the page frame + toolbar/footer separators so they don't read as bright. */
      --proser-edge: color-mix(in srgb, var(--vscode-panel-border) 30%, transparent); }
    body { display: flex; flex-direction: column; }

    /* Hide Toast UI's own toolbar / mode switch — we provide our own. */
    .toastui-editor-toolbar, .toastui-editor-mode-switch { display: none !important; }

    #toolbar {
      display: flex; align-items: center; gap: 6px;
      padding: 6px 10px; border-bottom: 1px solid var(--proser-edge);
      background: var(--vscode-editor-background); flex: 0 0 auto;
    }
    #toolbar .spacer { flex: 1 1 auto; }
    /* One shared height for every control so the row reads as a single, even strip. */
    #toolbar button, #toolbar .seg { height: 28px; box-sizing: border-box; }
    #toolbar button {
      display: inline-flex; align-items: center; justify-content: center; gap: 5px;
      font: inherit; font-size: 12px; line-height: 1; cursor: pointer;
      color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground, transparent);
      border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 0 11px;
      transition: background 0.12s ease, border-color 0.12s ease;
    }
    #toolbar button:hover { background: var(--vscode-toolbar-hoverBackground); }
    #toolbar button svg { pointer-events: none; display: block; }
    #toolbar .caret { opacity: 0.7; }
    /* Toggle buttons (e.g. Spelling) show a filled state when active. */
    #toolbar button.toggle.active {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }
    #toolbar button.toggle.active:hover { background: var(--vscode-button-hoverBackground); }

    /* Segmented mode toggle — a pill with a filled active segment, same height. */
    #toolbar .seg {
      display: inline-flex; align-items: center; gap: 2px; padding: 2px;
      border: 1px solid var(--vscode-panel-border); border-radius: 7px;
      background: var(--vscode-keybindingLabel-background, rgba(128,128,128,0.14));
    }
    #toolbar .seg button {
      height: 22px; border: none; border-radius: 5px; padding: 0 14px;
      background: transparent; color: var(--vscode-descriptionForeground);
      transition: background 0.12s ease, color 0.12s ease;
    }
    #toolbar .seg button:not(.active):hover {
      color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground);
    }
    #toolbar .seg button.active {
      background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    }

    /* Font stepper — square −/+ buttons matching the shared height, value between. */
    #toolbar .fontctl { display: inline-flex; align-items: center; gap: 4px; }
    #toolbar .fontctl button { width: 28px; padding: 0; font-size: 15px; }
    #fontSize { min-width: 22px; text-align: center; font-size: 12px; opacity: 0.85; }

    #editorWrap { flex: 1 1 auto; position: relative; min-height: 0; }
    #editor { position: absolute; inset: 0; }
    #preview {
      position: absolute; inset: 0; overflow: auto; padding: 16px 24px;
      background: var(--vscode-editor-background); display: none;
    }

    #footer {
      flex: 0 0 auto; padding: 3px 12px; font-size: 12px; opacity: 0.8;
      border-top: 1px solid var(--proser-edge);
      background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground);
    }
    /* Stats (left) + model selector (right) span the full frame width, sitting at
       its far edges — not aligned to the text column. */
    #footer #footerInner { display: flex; align-items: center; justify-content: space-between; gap: 12px; width: 100%; }
    #footer #model { cursor: pointer; white-space: nowrap; }
    #footer #model:hover { color: var(--vscode-foreground); text-decoration: underline; }

    /* Match the VS Code theme instead of Toast UI's light palette. */
    .toastui-editor-defaultUI,
    .toastui-editor-main, .toastui-editor-md-container, .toastui-editor-ww-container,
    .toastui-editor-md-preview, .toastui-editor-md-tab-container,
    #editor, #preview {
      background-color: var(--vscode-editor-background) !important;
      border-color: var(--proser-edge) !important;
    }
    /* Force all text to the theme foreground (Toast sets per-element colors). */
    .toastui-editor-contents, .toastui-editor-contents *,
    .ProseMirror, .ProseMirror *,
    #preview, #preview * {
      color: var(--vscode-editor-foreground) !important;
      background-color: transparent;
      border-color: var(--vscode-panel-border);
      caret-color: var(--vscode-editorCursor-foreground, var(--vscode-editor-foreground));
    }
    /* Links and code re-themed (more specific, so they win). */
    .toastui-editor-contents a, #preview a { color: var(--vscode-textLink-foreground) !important; }
    .toastui-editor-contents code, .toastui-editor-contents pre,
    .toastui-editor-ww-code-block, .toastui-editor-ww-code-block pre,
    #preview code, #preview pre {
      background-color: var(--vscode-textCodeBlock-background, rgba(127,127,127,0.18)) !important;
      border-radius: 4px;
    }
    .toastui-editor-contents blockquote, #preview blockquote {
      border-left: 3px solid var(--vscode-panel-border) !important;
      color: var(--vscode-descriptionForeground) !important;
    }
    .toastui-editor-contents hr, #preview hr { border-top: 1px solid var(--vscode-panel-border) !important; }
    .toastui-editor-contents table th, .toastui-editor-contents table td,
    #preview th, #preview td { border: 1px solid var(--vscode-panel-border) !important; }
    .toastui-editor-md-splitter { background-color: var(--vscode-panel-border) !important; }
    /* Hide Toast's WYSIWYG code-block language widget (the floating "js ✎"). */
    .toastui-editor-ww-code-block-language { display: none !important; }

    /* Markdown mode = raw source. Toast styles its source pane in the same
       proportional font as the rendered view, so on a plain-prose file the two
       modes look identical. Force the source editor to the VS Code monospace
       font so "Markdown" is unmistakably the underlying text. Scoped to
       md-container only — the Pretty (ww-container) view is untouched. */
    .toastui-editor-md-container .ProseMirror {
      font-family: var(--vscode-editor-font-family, 'SFMono-Regular', Consolas, 'Courier New', monospace) !important;
    }

    /* Proser right-click menu (Synonyms / Antonyms / Revise with AI). */
    #proser-ctx {
      position: fixed; z-index: 1000; display: none; min-width: 168px; padding: 4px;
      background: var(--vscode-menu-background, var(--vscode-editor-background));
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
      border-radius: 6px; box-shadow: 0 3px 10px rgba(0,0,0,0.35);
    }
    #proser-ctx button {
      display: block; width: 100%; text-align: left; border: none; background: transparent;
      color: inherit; padding: 6px 12px; border-radius: 4px; cursor: pointer; font: inherit;
    }
    #proser-ctx button:hover:not(:disabled) {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, inherit);
    }
    #proser-ctx button:disabled {
      opacity: 0.4; cursor: default;
    }
    /* Inline-formatting icon row (Bold / Italic / Underline / Strikethrough / Code).
       More specific than the generic "#proser-ctx button" rule, so the icons stay
       compact and centered instead of full-width menu items. The inner <b>/<i>/<u>/<s>
       keep their default styling so each glyph shows what it does. */
    #proser-ctx .fmt {
      display: flex; gap: 2px; padding: 0 2px 4px; margin-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border);
    }
    #proser-ctx .fmt button {
      display: inline-flex; align-items: center; justify-content: center;
      width: 32px; height: 28px; padding: 0; text-align: center; font-size: 13px;
    }
    /* Action rows: a full-width label (Synonyms/Antonyms/Revise) plus a trailing
       config icon. The gear governs synonyms AND antonyms (one shared icon); the
       robot opens the AI model picker for Revise. */
    #proser-ctx .act-group, #proser-ctx .act-row { display: flex; align-items: center; }
    #proser-ctx .act-labels { flex: 1 1 auto; min-width: 0; }
    #proser-ctx .act-row > [data-act="revise"] { flex: 1 1 auto; width: auto; }
    #proser-ctx .act-cfg {
      flex: 0 0 auto; width: 34px; height: 30px; padding: 0; align-self: center;
      display: inline-flex; align-items: center; justify-content: center; opacity: 0.6;
    }
    #proser-ctx .act-cfg:hover:not(:disabled) { opacity: 1; }
    #proser-ctx .act-cfg svg { width: 15px; height: 15px; display: block; }

    /* Anchored synonym/antonym card (appears under the word). */
    #proser-suggest {
      position: fixed; z-index: 1001; min-width: 200px; max-width: 320px; padding: 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.4);
    }
    #proser-suggest .psg-title {
      font-size: 11px; opacity: 0.7; padding: 2px 4px 6px; text-transform: uppercase; letter-spacing: 0.04em;
    }
    #proser-suggest .psg-options, #proser-suggest .psg-more { display: flex; flex-direction: column; gap: 3px; }
    #proser-suggest .psg-more { display: none; margin-top: 3px; max-height: 220px; overflow: auto; }
    #proser-suggest .psg-opt {
      text-align: left; border: none; border-left: 3px solid transparent; background: transparent;
      color: inherit; padding: 5px 9px; border-radius: 4px; cursor: pointer; font: inherit;
    }
    #proser-suggest .psg-opt:hover { background: var(--vscode-list-hoverBackground); }
    #proser-suggest .psg-opt.c0 { border-left-color: var(--proser-opt-1); }
    #proser-suggest .psg-opt.c1 { border-left-color: var(--proser-opt-2); }
    #proser-suggest .psg-opt.c2 { border-left-color: var(--proser-opt-3); }
    #proser-suggest .psg-opt.cx { border-left-color: var(--vscode-panel-border); }
    #proser-suggest .psg-actions {
      display: flex; justify-content: space-between; gap: 8px; margin-top: 8px;
      padding-top: 6px; border-top: 1px solid var(--vscode-panel-border);
    }
    #proser-suggest .psg-link {
      border: none; background: transparent; color: var(--vscode-textLink-foreground);
      cursor: pointer; font: inherit; padding: 2px 4px;
    }
    #proser-suggest .psg-link:hover { text-decoration: underline; }

    /* Anchored "Revise with AI" card (3 options under the passage). */
    #proser-revise {
      position: fixed; z-index: 1001; min-width: 320px; max-width: 540px; padding: 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 8px; box-shadow: 0 4px 14px rgba(0,0,0,0.45);
    }
    #proser-revise .prv-head {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      padding: 2px 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); margin-bottom: 8px;
    }
    #proser-revise .prv-title { flex: 1 1 auto; font-size: 11px; opacity: 0.7; text-transform: uppercase; letter-spacing: 0.04em; }
    #proser-revise .prv-actions { display: flex; gap: 8px; }
    #proser-revise .prv-close { border: none; background: transparent; color: var(--vscode-descriptionForeground);
      cursor: pointer; font: inherit; font-size: 13px; line-height: 1; padding: 2px 5px; border-radius: 4px; }
    #proser-revise .prv-close:hover { color: var(--vscode-foreground); background: var(--vscode-toolbar-hoverBackground); }
    #proser-revise .psg-link {
      border: none; background: transparent; color: var(--vscode-textLink-foreground);
      cursor: pointer; font: inherit; padding: 2px 4px;
    }
    #proser-revise .psg-link:hover { text-decoration: underline; }
    #proser-revise .prv-opt {
      display: flex; gap: 10px; align-items: flex-start; padding: 7px 8px; margin-bottom: 6px;
      border-left: 3px solid transparent; border-radius: 4px; background: var(--vscode-list-hoverBackground, transparent);
    }
    #proser-revise .prv-opt.c0 { border-left-color: var(--proser-opt-1); }
    #proser-revise .prv-opt.c1 { border-left-color: var(--proser-opt-2); }
    #proser-revise .prv-opt.c2 { border-left-color: var(--proser-opt-3); }
    #proser-revise .prv-text { flex: 1 1 auto; max-height: 140px; overflow: auto; line-height: 1.4; white-space: pre-wrap; }
    #proser-revise .prv-accept {
      flex: 0 0 auto; align-self: center; border: none; cursor: pointer; font: inherit;
      padding: 4px 12px; border-radius: 4px;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #proser-revise .prv-accept:hover { background: var(--vscode-button-hoverBackground); }

    /* Prompt-input stage (under the selection): instruction + quick-slot chips. */
    #proser-revise .prv-input {
      width: 100%; box-sizing: border-box; resize: vertical; min-height: 46px; max-height: 160px;
      font: inherit; line-height: 1.4; padding: 7px 9px; border-radius: 6px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    }
    #proser-revise .prv-input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    #proser-revise .prv-runrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 7px; }
    #proser-revise .prv-hint { font-size: 11px; opacity: 0.6; }
    #proser-revise .prv-run {
      border: none; cursor: pointer; font: inherit; padding: 5px 14px; border-radius: 5px;
      color: var(--vscode-button-foreground); background: var(--vscode-button-background);
    }
    #proser-revise .prv-run:hover { background: var(--vscode-button-hoverBackground); }
    #proser-revise .prv-slots-label {
      font-size: 11px; opacity: 0.65; text-transform: uppercase; letter-spacing: 0.04em; margin: 10px 2px 5px;
    }
    /* Chips wrap; when they exceed ~3 rows the area scrolls instead of growing. */
    #proser-revise .prv-slots {
      display: flex; flex-wrap: wrap; gap: 6px; max-height: 108px; overflow-y: auto; padding: 1px;
    }
    #proser-revise .prv-chip {
      max-width: 100%; border: 1px solid var(--vscode-panel-border); cursor: pointer; font: inherit;
      padding: 4px 10px; border-radius: 999px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12));
    }
    #proser-revise .prv-chip:hover { background: var(--vscode-toolbar-hoverBackground); }
    #proser-revise .prv-empty { font-size: 12px; opacity: 0.6; padding: 2px; }

    /* Manage (CRUD) stage: a scrollable list of name + prompt + delete. */
    #proser-revise .prv-manage { max-height: 320px; overflow-y: auto; padding: 1px; }
    #proser-revise .prv-mrow {
      display: grid; grid-template-columns: 1fr auto; gap: 6px 8px; align-items: start;
      padding: 7px; margin-bottom: 7px; border: 1px solid var(--vscode-panel-border); border-radius: 6px;
    }
    #proser-revise .prv-mname, #proser-revise .prv-mtext {
      width: 100%; box-sizing: border-box; font: inherit; padding: 4px 7px; border-radius: 4px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    }
    #proser-revise .prv-mname { font-weight: 600; }
    #proser-revise .prv-mtext { grid-column: 1 / 2; resize: vertical; min-height: 38px; line-height: 1.35; }
    #proser-revise .prv-del {
      grid-column: 2; grid-row: 1 / 3; align-self: center; border: none; cursor: pointer; font: inherit;
      padding: 4px 9px; border-radius: 4px; color: var(--vscode-foreground);
      background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12));
    }
    #proser-revise .prv-del:hover {
      color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
      background: var(--vscode-inputValidation-errorBackground, var(--vscode-toolbar-hoverBackground));
    }
    #proser-revise .prv-add {
      width: 100%; border: 1px dashed var(--vscode-panel-border); cursor: pointer; font: inherit;
      padding: 6px; border-radius: 6px; color: var(--vscode-foreground); background: transparent;
    }
    #proser-revise .prv-add:hover { background: var(--vscode-toolbar-hoverBackground); }

    /* Find bar (Ctrl/Cmd+F). */
    #proser-find {
      position: fixed; top: 48px; right: 18px; z-index: 1002; display: none;
      align-items: center; gap: 6px; padding: 5px 8px;
      background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
      border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      border-radius: 6px; box-shadow: 0 3px 10px rgba(0,0,0,0.35);
    }
    #proser-find input {
      font: inherit; padding: 3px 7px; border-radius: 4px; width: 190px;
      color: var(--vscode-input-foreground); background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    }
    /* Find matches are painted with the CSS Custom Highlight API, so the find
       input never loses focus to a document selection. */
    ::highlight(proser-find) {
      background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234,179,8,0.35));
    }
    ::highlight(proser-find-current) {
      background-color: var(--vscode-editor-findMatchBackground, rgba(234,179,8,0.75));
      color: var(--vscode-editor-foreground);
    }
    /* Misspelled words (Proser's dictionary) — a red wavy underline drawn over
       the text without touching ProseMirror. A faint tint is the fallback for
       engines that ignore text-decoration on highlight pseudo-elements. */
    ::highlight(proser-misspell) {
      text-decoration: underline wavy var(--vscode-editorError-foreground, #f14c4c);
      text-decoration-skip-ink: none;
      background-color: rgba(241, 76, 76, 0.12);
    }
    /* A passage revealed from the sidebar checker's "Go" — flashed briefly. */
    ::highlight(proser-reveal) {
      background-color: var(--vscode-editor-findMatchHighlightBackground, rgba(234,179,8,0.45));
      color: var(--vscode-editor-foreground);
    }
    #proser-find .fcount { font-size: 11px; opacity: 0.7; min-width: 64px; text-align: right; }
    #proser-find button {
      border: none; background: transparent; color: var(--vscode-foreground);
      cursor: pointer; font: inherit; padding: 2px 7px; border-radius: 4px;
    }
    #proser-find button:hover { background: var(--vscode-toolbar-hoverBackground); }
  </style>
  <title>Proser</title>
</head>
<body>
  <div id="toolbar">
    <div class="seg" id="modeToggle">
      <button data-mode="pretty" class="active" title="Edit in the rendered view">Pretty</button>
      <button data-mode="markdown" title="Edit the raw Markdown source">Markdown</button>
    </div>
    <div class="spacer"></div>
    <button id="spellToggle" class="toggle" title="Toggle spell check (this view + Markdown)">Spelling</button>
    <button id="issuesBtn" title="Editor checks — tense / passive voice / continuity — toggle the panel">Editor</button>
    <button id="brainstormBtn" title="Brainstorm with AI — names, plots, scene ideas…">Brainstorm</button>
    <div class="fontctl">
      <button id="fontMinus" title="Decrease font size">−</button>
      <span id="fontSize">18</span>
      <button id="fontPlus" title="Increase font size">+</button>
    </div>
    <button id="exportBtn" title="Export — DOCX/PDF (manuscript format) for this file or the whole folder">Export<svg class="caret" width="9" height="9" viewBox="0 0 10 10" aria-hidden="true"><path d="M2.5 4 5 6.5 7.5 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
  </div>
  <div id="editorWrap">
    <div id="editor"></div>
  </div>
  <div id="footer">
    <div id="footerInner">
      <span id="stats"></span>
      <span id="model" title="Switch AI model"></span>
    </div>
  </div>
  <div id="proser-find">
    <input id="findInput" type="text" placeholder="Find" spellcheck="false" />
    <span id="findCount" class="fcount"></span>
    <button id="findPrev" title="Previous (Shift+Enter)">↑</button>
    <button id="findNext" title="Next (Enter)">↓</button>
    <button id="findClose" title="Close (Esc)">✕</button>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
