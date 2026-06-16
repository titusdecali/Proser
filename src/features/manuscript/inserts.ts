/** "Insert" actions for the manuscript sidebar. Each injects correctly-
 *  structured Markdown the compiler/exporters understand. The real page
 *  formatting (breaks, centering, double-spacing) happens on export. */
import * as vscode from 'vscode';
import { activeMarkdownDoc, manuscriptFolder } from './compile';
import { ensureMeta, promptMeta, readMeta } from './config';

/** Inserts text at the raw-editor cursor when available, else appends to the
 *  active manuscript document (e.g. when the pretty editor is focused). */
async function insertIntoActiveDoc(text: string): Promise<boolean> {
  const doc = activeMarkdownDoc();
  if (!doc) {
    void vscode.window.showWarningMessage('Open a Markdown file first.');
    return false;
  }
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.uri.toString() === doc.uri.toString()) {
    await editor.edit((b) => b.insert(editor.selection.active, text));
    return true;
  }
  const edit = new vscode.WorkspaceEdit();
  const end = doc.lineAt(doc.lineCount - 1).range.end;
  edit.insert(doc.uri, end, text);
  return vscode.workspace.applyEdit(edit);
}

export async function insertChapter(): Promise<void> {
  const title = await vscode.window.showInputBox({
    title: 'New Chapter',
    prompt: 'Chapter heading (each chapter file starts a fresh page on export)',
    placeHolder: 'e.g. Chapter One — The Deadline',
    ignoreFocusOut: true
  });
  if (title === undefined) {
    return;
  }
  await insertIntoActiveDoc(`\n\n# ${title.trim() || 'Chapter'}\n\n`);
}

export async function insertSceneBreak(): Promise<void> {
  await insertIntoActiveDoc('\n\n#\n\n');
}

export async function insertPartDivider(): Promise<void> {
  const title = await vscode.window.showInputBox({
    title: 'Part Divider',
    prompt: 'Part title (gets its own centered page)',
    value: 'Part One',
    ignoreFocusOut: true
  });
  if (title === undefined) {
    return;
  }
  await insertIntoActiveDoc(`\n\n<!-- proser:part ${title.trim() || 'Part One'} -->\n\n`);
}

export async function insertTheEnd(): Promise<void> {
  await insertIntoActiveDoc('\n\n<!-- proser:end -->\n');
}

/** Opens the title-page form (create or edit the folder's manuscript metadata). */
export async function editTitlePage(): Promise<void> {
  const folder = manuscriptFolder();
  if (!folder) {
    void vscode.window.showWarningMessage('Open a manuscript file or folder first.');
    return;
  }
  const existing = await readMeta(folder);
  const meta = await promptMeta(folder, existing);
  if (meta) {
    void vscode.window.showInformationMessage(`Saved title page for "${meta.title}".`);
  }
}

/** Used by exporters to obtain metadata, prompting on first run. */
export { ensureMeta };
