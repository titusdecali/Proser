/** The "Manuscript" sidebar view (Activity Bar). Themed buttons that fire the
 *  manuscript commands; buttons map to an allow-listed command id only. */
import * as vscode from 'vscode';
import { Commands } from '../../constants';
import { getNonce } from '../../util/nonce';

const BUTTONS = new Set<string>([
  Commands.manuscriptTitlePage,
  Commands.manuscriptNewChapter,
  Commands.manuscriptSceneBreak,
  Commands.manuscriptPartDivider,
  Commands.manuscriptTheEnd,
  Commands.manuscriptExportDocx,
  Commands.manuscriptExportPdf
]);

export const MANUSCRIPT_VIEW_ID = 'proser.manuscriptView';

export class ManuscriptSidebar implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = this.html();
    view.webview.onDidReceiveMessage((msg: { command?: string }) => {
      if (msg.command && BUTTONS.has(msg.command)) {
        void vscode.commands.executeCommand(msg.command);
      }
    });
  }

  private html(): string {
    const nonce = getNonce();
    const btn = (cmd: string, label: string, icon: string) =>
      `<button class="pm-btn" data-cmd="${cmd}"><span class="pm-ico">${icon}</span>${label}</button>`;
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  body { padding: 8px 10px; font: var(--vscode-font-size) var(--vscode-font-family); }
  .pm-h { font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    opacity: 0.65; margin: 14px 2px 6px; }
  .pm-h:first-child { margin-top: 2px; }
  .pm-btn { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
    margin: 4px 0; padding: 7px 10px; cursor: pointer; font: inherit;
    color: var(--vscode-foreground);
    background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12));
    border: 1px solid var(--vscode-panel-border); border-radius: 6px; }
  .pm-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .pm-ico { font-size: 14px; width: 16px; text-align: center; opacity: 0.9; }
  .pm-export { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border-color: transparent; }
  .pm-export:hover { background: var(--vscode-button-hoverBackground); }
  .pm-note { font-size: 11px; opacity: 0.6; margin: 10px 2px 2px; line-height: 1.4; }
</style>
</head>
<body>
  <div class="pm-h">Insert</div>
  ${btn(Commands.manuscriptNewChapter, 'New Chapter', '¶')}
  ${btn(Commands.manuscriptSceneBreak, 'Scene Break', '#')}
  ${btn(Commands.manuscriptPartDivider, 'Part Divider', '§')}
  ${btn(Commands.manuscriptTheEnd, 'THE END', '✦')}

  <div class="pm-h">Manuscript</div>
  ${btn(Commands.manuscriptTitlePage, 'Title &amp; Author…', '✎')}
  <button class="pm-btn pm-export" data-cmd="${Commands.manuscriptExportDocx}"><span class="pm-ico">⤓</span>Export DOCX</button>
  <button class="pm-btn pm-export" data-cmd="${Commands.manuscriptExportPdf}"><span class="pm-ico">⤓</span>Export PDF</button>

  <div class="pm-note">Exports compile every chapter file in this folder, in order,
    into Standard Manuscript Format (Courier 12pt, double-spaced, 1" margins).</div>

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  for (const b of document.querySelectorAll('.pm-btn')) {
    b.addEventListener('click', () => vscode.postMessage({ command: b.dataset.cmd }));
  }
</script>
</body>
</html>`;
  }
}
