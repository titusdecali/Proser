import * as vscode from 'vscode';
import { getNonce } from '../../util/nonce';

/** HTML for the Spelling sidebar webview view. */
export function getSpellingHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'spelling.js'));
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
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">
    body { margin: 0; padding: 8px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 13px; }
    #langbar { display: flex; align-items: center; justify-content: space-between; gap: 8px;
      margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid var(--vscode-panel-border); opacity: 0.9; }
    #langbar .langchange { border: none; background: transparent; color: var(--vscode-textLink-foreground);
      cursor: pointer; font: inherit; padding: 2px 4px; }
    #langbar .langchange:hover { text-decoration: underline; }
    #status { opacity: 0.75; margin: 2px 0 10px; min-height: 16px; }
    #list { display: flex; flex-direction: column; gap: 8px; }
    .item {
      border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-editorError-foreground, #f14c4c);
      border-radius: 6px; padding: 7px 9px; background: var(--vscode-editorWidget-background, transparent);
    }
    .item .word { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
    .item .wordbtn {
      border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; font: inherit;
      font-weight: 600; padding: 0; text-decoration: underline wavy var(--vscode-editorError-foreground, #f14c4c);
      text-decoration-skip-ink: none;
    }
    .item .wordbtn:hover { color: var(--vscode-textLink-foreground); }
    .item .count { font-size: 11px; opacity: 0.6; }
    .item .suggestions { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
    .item .sugg {
      border: 1px solid var(--vscode-panel-border); border-radius: 999px; cursor: pointer; font: inherit; font-size: 12px;
      padding: 2px 10px; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12));
    }
    .item .sugg:hover { background: var(--vscode-toolbar-hoverBackground); }
    .item .none { font-size: 12px; opacity: 0.55; }
    .item .actions { display: flex; gap: 6px; flex-wrap: wrap; }
    .item .go, .item .add, .item .ignore {
      border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground);
      cursor: pointer; font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 4px;
    }
    .item .ignore { color: var(--vscode-descriptionForeground); }
    .item .go { margin-left: auto; } /* push to the far right of the row */
    .item .go:hover, .item .add:hover, .item .ignore:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
  </style>
  <title>Spelling</title>
</head>
<body>
  <div id="langbar"></div>
  <div id="status"></div>
  <div id="list"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
