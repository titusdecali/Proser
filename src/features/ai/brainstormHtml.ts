import * as vscode from 'vscode';
import { getNonce } from '../../util/nonce';
import { PROSER_THEME_VARS } from '../../util/webviewTheme';

/** HTML for the Brainstorm chat panel (a wide editor-area webview). The chat
 *  logic + preset prompts live in the bundled media/brainstorm.js. */
export function getBrainstormHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'brainstorm.js')
  );
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { ${PROSER_THEME_VARS} }
  html, body { height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; font: var(--vscode-font-size) var(--vscode-font-family);
    color: var(--vscode-foreground); background: var(--vscode-editor-background); }

  header { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    border-bottom: 1px solid var(--vscode-panel-border); }
  header .title { font-weight: 600; }
  header .model-select { font: inherit; font-size: 11px; color: var(--vscode-descriptionForeground);
    background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 2px 6px; cursor: pointer;
    max-width: 180px; }
  header .model-select:hover { border-color: var(--vscode-panel-border); color: var(--vscode-foreground); }
  header .model-select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .gear-btn { display: inline-flex; align-items: center; justify-content: center; width: 26px; height: 26px;
    cursor: pointer; color: var(--vscode-descriptionForeground); background: transparent;
    border: 1px solid transparent; border-radius: 6px; transition: color 0.12s, border-color 0.12s, background 0.12s; }
  .gear-btn:hover { color: var(--vscode-foreground); border-color: var(--vscode-focusBorder); background: var(--vscode-toolbar-hoverBackground); }
  .gear-btn svg { width: 14px; height: 14px; display: block; }
  header .spacer { flex: 1; }
  header button { font: inherit; font-size: 12px; cursor: pointer; color: var(--vscode-foreground);
    background: transparent; border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 3px 10px; }
  header button:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }

  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
  .empty { margin: auto; max-width: 520px; text-align: center; color: var(--vscode-descriptionForeground);
    line-height: 1.6; }
  .msg { max-width: 760px; padding: 10px 13px; border-radius: 10px; white-space: pre-wrap; line-height: 1.5;
    word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-bottom-right-radius: 3px; }
  .msg.ai { align-self: flex-start; background: var(--vscode-editorWidget-background, rgba(128,128,128,0.10));
    border: 1px solid var(--vscode-panel-border); border-bottom-left-radius: 3px; }
  .msg.ai.error { border-color: var(--vscode-editorError-foreground, #f14c4c);
    color: var(--vscode-editorError-foreground, #f14c4c); }
  .caret::after { content: '▋'; opacity: 0.5; animation: blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity: 0; } }

  /* History / Rescan — a button that opens a popover menu. */
  .histwrap, .rescanwrap { position: relative; }
  #rescanbtn { display: inline-flex; align-items: center; gap: 6px; }
  #rescanbtn .chev { font-size: 9px; opacity: 0.7; }
  #histbtn { display: inline-flex; align-items: center; gap: 6px; }
  #histbtn .chev { font-size: 9px; opacity: 0.7; }
  .histmenu { position: absolute; right: 0; top: calc(100% + 6px); z-index: 30;
    width: 260px; max-height: 320px; overflow-y: auto; padding: 6px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px;
    box-shadow: 0 6px 22px rgba(0,0,0,0.35); }
  .histmenu[hidden] { display: none; }
  .histhd { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
    color: var(--vscode-descriptionForeground); padding: 4px 8px 6px; }
  .histrow { display: flex; align-items: center; border-radius: 6px; }
  .histrow:hover { background: var(--vscode-toolbar-hoverBackground); }
  .histrow.active { background: var(--vscode-list-activeSelectionBackground, var(--vscode-toolbar-hoverBackground));
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
  .histitem { flex: 1 1 auto; min-width: 0; text-align: left; font: inherit; font-size: 12px; cursor: pointer;
    color: inherit; background: transparent; border: none; border-radius: 6px; padding: 7px 9px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .histdel { flex: 0 0 auto; width: 24px; height: 24px; margin-right: 4px; display: inline-flex;
    align-items: center; justify-content: center; cursor: pointer; font-size: 11px; line-height: 1;
    color: var(--vscode-descriptionForeground); background: transparent; border: none; border-radius: 5px;
    opacity: 0.5; transition: opacity 0.12s ease, background 0.12s ease, color 0.12s ease; }
  .histrow:hover .histdel { opacity: 1; }
  .histdel:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-editorError-foreground, #f14c4c); }
  .histempty { padding: 12px 9px; font-size: 12px; color: var(--vscode-descriptionForeground); text-align: center; }

  footer { border-top: 1px solid var(--vscode-panel-border); padding: 10px 14px 14px; }
  .ctxwarn { font-size: 12px; line-height: 1.45; margin-bottom: 10px; padding: 7px 10px; border-radius: 6px;
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, rgba(255,193,7,0.12));
    border: 1px solid var(--vscode-inputValidation-warningBorder, rgba(255,193,7,0.5)); }
  #ctx { color: var(--vscode-descriptionForeground); }
  .presets { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .preset { font: inherit; font-size: 12px; cursor: pointer; color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.10));
    border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 3px 11px;
    border-left-width: 3px; border-left-color: var(--proser-opt-3); transition: background 0.12s, border-color 0.12s; }
  .preset:nth-child(3n+1) { border-left-color: var(--proser-opt-1); }
  .preset:nth-child(3n+2) { border-left-color: var(--proser-opt-2); }
  .preset:hover { background: var(--vscode-toolbar-hoverBackground); }
  .composer { display: flex; gap: 8px; align-items: flex-end; position: relative; }

  /* @chapter mention autocomplete — a popover above the composer. */
  .mentions { position: absolute; left: 0; right: 0; bottom: calc(100% + 6px); z-index: 40;
    max-height: 240px; overflow-y: auto; padding: 5px;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-panel-border); border-radius: 8px; box-shadow: 0 6px 22px rgba(0,0,0,0.35); }
  .mentions[hidden] { display: none; }
  .mhdr { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
    color: var(--vscode-descriptionForeground); padding: 4px 8px 6px; }
  .mention { display: flex; align-items: baseline; gap: 9px; padding: 7px 9px; border-radius: 6px; cursor: pointer; }
  .mention.active, .mention:hover { background: var(--vscode-list-activeSelectionBackground, var(--vscode-toolbar-hoverBackground));
    color: var(--vscode-list-activeSelectionForeground, var(--vscode-foreground)); }
  .mention .mat { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .mention .mtitle { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  textarea { flex: 1; resize: none; min-height: 38px; max-height: 200px; box-sizing: border-box;
    font: inherit; font-size: 13px; line-height: 1.45; color: var(--vscode-input-foreground);
    background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: 8px; padding: 9px 11px; scrollbar-width: none; }
  textarea::-webkit-scrollbar { width: 0; height: 0; } /* auto-grows, so no scrollbar */
  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #send { font: inherit; font-size: 13px; cursor: pointer; color: var(--vscode-button-foreground);
    background: var(--vscode-button-background); border: none; border-radius: 8px; padding: 0 16px; height: 38px;
    flex: 0 0 auto; }
  #send:hover { background: var(--vscode-button-hoverBackground); }
  #send.stop { background: var(--vscode-editorError-foreground, #f14c4c); }
  .hint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 6px; }
</style>
</head>
<body>
  <header>
    <span class="title">Brainstorm</span>
    <select id="modelSelect" class="model-select" title="Brainstorm / editor model — click to switch"></select>
    <button id="modelManage" class="gear-btn" title="Add / Remove Models" aria-label="Add or remove models">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </button>
    <span class="spacer"></span>
    <div class="rescanwrap">
      <button id="rescanbtn" title="Re-scan your manuscript into Story Memory" aria-haspopup="true" aria-expanded="false">
        Rescan <span class="chev">▾</span>
      </button>
      <div id="rescanmenu" class="histmenu" hidden></div>
    </div>
    <div class="histwrap">
      <button id="histbtn" title="Past chats" aria-haspopup="true" aria-expanded="false">
        History <span class="chev">▾</span>
      </button>
      <div id="histmenu" class="histmenu" hidden></div>
    </div>
    <button id="newchat" title="Start a fresh conversation">New chat</button>
  </header>

  <div id="log">
    <div class="empty" id="empty">
      Chat with your local model for ideas: names, plots, conflicts, scene starters, etc.<br>
      Tap a prompt below to start, fill in the blanks, and hit Send.
    </div>
  </div>

  <footer>
    <div class="ctxwarn" id="ctxwarn" hidden></div>
    <div class="presets" id="presets"></div>
    <div class="composer">
      <div id="mentions" class="mentions" hidden></div>
      <textarea id="input" rows="1" placeholder="Ask for ideas…  (type @ to reference a file · Enter to send)"></textarea>
      <button id="send">Send</button>
    </div>
    <div class="hint">Type <b>@</b> to add a file to the model's context. Ideas are starting points.<span id="ctx"></span></div>
  </footer>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
