/** Wires the manuscript feature: insert commands, the title-page form, the
 *  DOCX/PDF exporters (compile folder → render → save → open), and the sidebar. */
import * as vscode from 'vscode';
import { Commands } from '../../constants';
import { activeMarkdownDoc, compileChapters, gatherChapterFiles, manuscriptFolder } from './compile';
import { ensureMeta } from './config';
import { buildDocx } from './exportDocx';
import { buildPdf } from './exportPdf';
import { editTitlePage, insertChapter, insertDivider, insertSceneBreak } from './inserts';
import { MANUSCRIPT_VIEW_ID, ManuscriptSidebar } from './sidebar';

function safeName(title: string): string {
  return (title || 'Manuscript').replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'Manuscript';
}

type Scope = 'active' | 'folder';

/** Exports to Standard Manuscript Format. `scope` picks the source: just the
 *  active file, or every chapter file in its folder (compiled in order). */
async function exportManuscript(kind: 'docx' | 'pdf', scope: Scope): Promise<void> {
  let folder: vscode.Uri | undefined;
  let uris: vscode.Uri[];
  if (scope === 'active') {
    const doc = activeMarkdownDoc();
    if (!doc || doc.uri.scheme !== 'file') {
      void vscode.window.showWarningMessage('Open a Markdown file to export it.');
      return;
    }
    folder = vscode.Uri.joinPath(doc.uri, '..');
    uris = [doc.uri];
  } else {
    folder = manuscriptFolder();
    if (!folder) {
      void vscode.window.showWarningMessage('Open a manuscript file or folder first.');
      return;
    }
    uris = await gatherChapterFiles(folder);
  }

  const meta = await ensureMeta(folder);
  if (!meta) {
    return;
  }

  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Building ${kind.toUpperCase()} manuscript…` },
    async () => {
      const compiled = await compileChapters(uris, meta);
      if (compiled.files.length === 0) {
        return undefined;
      }
      const bytes =
        kind === 'docx' ? await buildDocx(compiled.book) : await buildPdf(compiled.book);
      return { bytes, ...compiled };
    }
  );

  if (!result) {
    void vscode.window.showWarningMessage(
      scope === 'active'
        ? 'This file is empty — nothing to export.'
        : 'No chapter files found in this folder to compile.'
    );
    return;
  }

  const baseName =
    scope === 'active'
      ? safeName(result.files[0]?.replace(/\.md$/i, '') ?? meta.title)
      : `${safeName(meta.title)} - Manuscript`;
  const defaultUri = vscode.Uri.joinPath(folder, `${baseName}.${kind}`);
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
  const sidebar = new ManuscriptSidebar(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(MANUSCRIPT_VIEW_ID, sidebar),
    // Toggles the sidebar on the Editor (checks) tab — used by the Pretty toolbar.
    vscode.commands.registerCommand(Commands.editorChecks, () => sidebar.toggleEditor()),
    vscode.commands.registerCommand(Commands.manuscriptTitlePage, editTitlePage),
    vscode.commands.registerCommand(Commands.manuscriptNewChapter, insertChapter),
    vscode.commands.registerCommand(Commands.manuscriptSceneBreak, insertSceneBreak),
    vscode.commands.registerCommand(Commands.manuscriptDivider, insertDivider),
    vscode.commands.registerCommand(Commands.manuscriptExportDocx, (scope?: Scope) =>
      exportManuscript('docx', scope ?? 'folder')
    ),
    vscode.commands.registerCommand(Commands.manuscriptExportPdf, (scope?: Scope) =>
      exportManuscript('pdf', scope ?? 'folder')
    )
  );
}
