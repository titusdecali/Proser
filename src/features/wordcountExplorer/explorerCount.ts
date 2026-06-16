import * as vscode from 'vscode';
import { Commands } from '../../constants';
import { countMarkdownWords } from '../../util/wordcount';
import { wordcountScanOptions } from '../../util/scanConfig';

/**
 * Explorer command: select one or more `.md` files, right-click →
 * "Count Words in Selection" → total across them.
 *
 * NOTE: VS Code exposes no event for passive file-explorer selection changes,
 * so this is necessarily an explicit command — it cannot live-update a status
 * indicator as files are clicked.
 */
export function registerExplorerWordCount(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand(
      Commands.countWordsInSelection,
      async (clickedUri?: vscode.Uri, selectedUris?: vscode.Uri[]) => {
        // When multiple files are selected, VS Code passes them as the 2nd arg.
        // Fall back to the single clicked file, then to the active editor.
        let uris = selectedUris && selectedUris.length > 0 ? selectedUris : undefined;
        if (!uris && clickedUri) {
          uris = [clickedUri];
        }
        if (!uris) {
          const active = vscode.window.activeTextEditor?.document.uri;
          uris = active ? [active] : [];
        }

        const mdUris = uris.filter((u) => u.path.toLowerCase().endsWith('.md'));
        if (mdUris.length === 0) {
          vscode.window.showInformationMessage('Select one or more Markdown (.md) files to count.');
          return;
        }

        const opts = wordcountScanOptions();
        let total = 0;
        let counted = 0;
        const failures: string[] = [];

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Window,
            title: 'Proser: counting words…'
          },
          async () => {
            for (const uri of mdUris) {
              try {
                // Prefer an already-open document so unsaved edits are counted.
                const open = vscode.workspace.textDocuments.find(
                  (d) => d.uri.toString() === uri.toString()
                );
                const text = open
                  ? open.getText()
                  : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
                total += countMarkdownWords(text, opts);
                counted++;
              } catch {
                failures.push(uri.path.split('/').pop() ?? uri.toString());
              }
            }
          }
        );

        const fileWord = counted === 1 ? 'file' : 'files';
        const summary = `${total.toLocaleString()} words across ${counted} ${fileWord}`;
        const detail = failures.length > 0 ? ` (couldn't read ${failures.length})` : '';
        vscode.window.setStatusBarMessage(`$(book) ${summary}${detail}`, 8000);
        vscode.window.showInformationMessage(`Proser: ${summary}${detail}`);
      }
    )
  );
}
