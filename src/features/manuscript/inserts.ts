/** "Insert" actions for the manuscript sidebar. "New Chapter" creates a new file
 *  ordered right after the active one; dividers/scene breaks inject at the cursor
 *  (the Pretty editor's cursor when it's focused, else the text editor's). */
import * as vscode from 'vscode';
import { Commands, VIEW_TYPE_MARKDOWN_EDITOR } from '../../constants';
import { activeMarkdownDoc, gatherChapterFiles, manuscriptFolder } from './compile';
import { ensureMeta, promptMeta, readMeta } from './config';

/** Inserts text at the cursor: raw-editor cursor when a text editor of the doc is
 *  focused; otherwise the Pretty editor's cursor (via its webview); else appends. */
async function insertAtCursor(text: string, hr = false): Promise<boolean> {
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
  // Pretty editor focused — let its webview insert at the Toast cursor.
  const handled = await vscode.commands.executeCommand(
    Commands.insertInPretty,
    doc.uri.toString(),
    hr ? 'hr' : 'text',
    text
  );
  if (handled) {
    return true;
  }
  // Fallback: append to the end of the document.
  const edit = new vscode.WorkspaceEdit();
  edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, text);
  return vscode.workspace.applyEdit(edit);
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50) || 'chapter'
  );
}

/** Leading numeric prefix of a chapter filename, e.g. "01.5-foo.md" → {num:1.5, width:2}. */
function parsePrefix(name: string): { num: number; width: number } | null {
  const m = /^(\d+)(?:\.(\d+))?/.exec(name);
  if (!m) {
    return null;
  }
  return { num: parseFloat(m[2] !== undefined ? `${m[1]}.${m[2]}` : m[1]), width: m[1].length };
}

/** Formats a (possibly fractional) prefix, zero-padding the integer part to `width`. */
function formatPrefix(num: number, width: number): string {
  const intStr = String(Math.floor(num)).padStart(width, '0');
  if (num % 1 === 0) {
    return intStr;
  }
  return `${intStr}.${num.toString().split('.')[1] ?? ''}`;
}

/** A filename that sorts immediately after `activeName` and before the next file
 *  (fractional prefix between them), or the next integer when it's the last. */
function nextChapterFilename(activeName: string, names: string[], title: string): string {
  const slug = slugify(title);
  const a = parsePrefix(activeName);
  if (!a) {
    return `${activeName.replace(/\.md$/i, '')}-${slug}.md`; // no number — sort right after it
  }
  const sorted = [...names].sort((x, y) => x.localeCompare(y, 'en'));
  const idx = sorted.indexOf(activeName);
  const nextName = idx >= 0 && idx < sorted.length - 1 ? sorted[idx + 1] : undefined;
  const b = nextName ? parsePrefix(nextName) : null;
  const newNum = b && b.num > a.num ? (a.num + b.num) / 2 : Math.floor(a.num) + 1;
  return `${formatPrefix(newNum, a.width)}-${slug}.md`;
}

export async function insertChapter(): Promise<void> {
  const title = await vscode.window.showInputBox({
    title: 'New Chapter',
    prompt: 'Chapter title — a new file is created right after the current one.',
    placeHolder: 'e.g. Chapter Two — The Deadline',
    ignoreFocusOut: true
  });
  if (title === undefined) {
    return;
  }
  const clean = title.trim() || 'Chapter';

  const active = activeMarkdownDoc();
  if (!active || active.uri.scheme !== 'file') {
    void vscode.window.showWarningMessage('Open a manuscript file to add a chapter after it.');
    return;
  }
  const folder = vscode.Uri.joinPath(active.uri, '..');
  const activeName = active.uri.path.split('/').pop() ?? '';
  const names = (await gatherChapterFiles(folder)).map((u) => u.path.split('/').pop() ?? '');

  const target = vscode.Uri.joinPath(folder, nextChapterFilename(activeName, names, clean));
  try {
    await vscode.workspace.fs.stat(target);
    void vscode.window.showWarningMessage(
      `"${target.path.split('/').pop()}" already exists — rename it and try again.`
    );
    return;
  } catch {
    /* doesn't exist — good */
  }
  await vscode.workspace.fs.writeFile(target, Buffer.from(`# ${clean}\n\n`, 'utf8'));
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE_MARKDOWN_EDITOR);
}

/** A horizontal-rule "bar line" at the cursor. */
export async function insertDivider(): Promise<void> {
  await insertAtCursor('\n\n---\n\n', true);
}

/** A `***` scene break at the cursor. */
export async function insertSceneBreak(): Promise<void> {
  await insertAtCursor('\n\n***\n\n');
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
