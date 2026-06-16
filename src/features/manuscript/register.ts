/** Wires the manuscript feature: insert commands, the title-page form, the
 *  DOCX/PDF exporters (compile folder → render → save → open), and the sidebar. */
import * as vscode from 'vscode';
import { Commands } from '../../constants';
import { compileBook, manuscriptFolder } from './compile';
import { ensureMeta } from './config';
import { buildDocx } from './exportDocx';
import { buildPdf } from './exportPdf';
import {
  editTitlePage,
  insertChapter,
  insertPartDivider,
  insertSceneBreak,
  insertTheEnd
} from './inserts';
import { MANUSCRIPT_VIEW_ID, ManuscriptSidebar } from './sidebar';

function safeName(title: string): string {
  return (title || 'Manuscript').replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'Manuscript';
}

async function exportManuscript(kind: 'docx' | 'pdf'): Promise<void> {
  const folder = manuscriptFolder();
  if (!folder) {
    void vscode.window.showWarningMessage('Open a manuscript file or folder first.');
    return;
  }
  const meta = await ensureMeta(folder);
  if (!meta) {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Building ${kind.toUpperCase()} manuscript…` },
    async () => {
      const compiled = await compileBook(folder, meta);
      if (compiled.files.length === 0) {
        return undefined;
      }
      const bytes =
        kind === 'docx' ? await buildDocx(compiled.book) : await buildPdf(compiled.book);
      return { bytes, ...compiled };
    }
  );

  if (!result) {
    void vscode.window.showWarningMessage('No chapter files found in this folder to compile.');
    return;
  }

  const defaultUri = vscode.Uri.joinPath(folder, `${safeName(meta.title)} - Manuscript.${kind}`);
  const target = await vscode.window.showSaveDialog({
    defaultUri,
    filters: kind === 'docx' ? { 'Word document': ['docx'] } : { PDF: ['pdf'] }
  });
  if (!target) {
    return;
  }
  await vscode.workspace.fs.writeFile(target, result.bytes);

  const open = await vscode.window.showInformationMessage(
    `Exported ${result.book.wordCount.toLocaleString('en-US')} words from ${result.files.length} chapter${result.files.length === 1 ? '' : 's'}.`,
    'Open',
    'Reveal'
  );
  if (open === 'Open') {
    await vscode.env.openExternal(target);
  } else if (open === 'Reveal') {
    await vscode.commands.executeCommand('revealFileInOS', target);
  }
}

export function registerManuscript(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MANUSCRIPT_VIEW_ID, new ManuscriptSidebar()),
    vscode.commands.registerCommand(Commands.manuscriptTitlePage, editTitlePage),
    vscode.commands.registerCommand(Commands.manuscriptNewChapter, insertChapter),
    vscode.commands.registerCommand(Commands.manuscriptSceneBreak, insertSceneBreak),
    vscode.commands.registerCommand(Commands.manuscriptPartDivider, insertPartDivider),
    vscode.commands.registerCommand(Commands.manuscriptTheEnd, insertTheEnd),
    vscode.commands.registerCommand(Commands.manuscriptExportDocx, () => exportManuscript('docx')),
    vscode.commands.registerCommand(Commands.manuscriptExportPdf, () => exportManuscript('pdf'))
  );
}
