/** Turns a folder of chapter `.md` files into a BookModel: files are taken in
 *  lexical (filename) order — the repo convention where the sort *is* the
 *  reading order — minus a configurable exclude list of reference files. */
import * as vscode from 'vscode';
import { EXTENSION_ID, MARKDOWN_LANGUAGE_ID, VIEW_TYPE_MARKDOWN_EDITOR } from '../../constants';
import { BookModel, Chapter, ManuscriptMeta, countWords, parseChapter } from './model';

/** Default basenames (without extension) treated as non-manuscript reference. */
const DEFAULT_EXCLUDE = [
  'readme',
  'notes',
  'bible',
  'threads',
  'arcs',
  'review',
  'changelog',
  'todo',
  'memory'
];

/** The Markdown document the user is currently looking at, raw editor or pretty. */
export function activeMarkdownDoc(): vscode.TextDocument | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === MARKDOWN_LANGUAGE_ID) {
    return editor.document;
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE_MARKDOWN_EDITOR) {
    const key = input.uri.toString();
    return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
  }
  return undefined;
}

/** The folder whose chapters we compile: the active file's directory, else the
 *  first workspace folder. */
export function manuscriptFolder(): vscode.Uri | undefined {
  const doc = activeMarkdownDoc();
  if (doc && doc.uri.scheme === 'file') {
    return vscode.Uri.joinPath(doc.uri, '..');
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

function excludeSet(): string[] {
  const extra = vscode.workspace
    .getConfiguration(EXTENSION_ID)
    .get<string[]>('manuscript.exclude', []);
  return [...DEFAULT_EXCLUDE, ...extra].map((s) => s.toLowerCase());
}

/** Prettifies a filename into a fallback chapter title:
 *  "21.5-the-merge.md" -> "The Merge". */
export function titleFromFilename(name: string): string {
  return name
    .replace(/\.md$/i, '')
    .replace(/^[\d.]+[-_\s]*/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function gatherChapterFiles(folder: vscode.Uri): Promise<vscode.Uri[]> {
  const entries = await vscode.workspace.fs.readDirectory(folder);
  const exclude = excludeSet();
  return entries
    .filter(([name, type]) => type === vscode.FileType.File && /\.md$/i.test(name))
    .map(([name]) => name)
    .filter((name) => {
      const base = name.replace(/\.md$/i, '').toLowerCase();
      return !exclude.some((ex) => base === ex || base.startsWith(ex));
    })
    .sort((a, b) => a.localeCompare(b, 'en'))
    .map((name) => vscode.Uri.joinPath(folder, name));
}

export interface CompileResult {
  book: BookModel;
  files: string[];
}

export async function compileBook(
  folder: vscode.Uri,
  meta: ManuscriptMeta
): Promise<CompileResult> {
  const uris = await gatherChapterFiles(folder);
  const chapters: Chapter[] = [];
  const files: string[] = [];
  for (const uri of uris) {
    const name = uri.path.split('/').pop() ?? 'chapter.md';
    const bytes = await vscode.workspace.fs.readFile(uri);
    const raw = Buffer.from(bytes).toString('utf8');
    if (!raw.trim()) {
      continue; // skip empty stubs
    }
    chapters.push(parseChapter(raw, titleFromFilename(name)));
    files.push(name);
  }
  const book: BookModel = { meta, chapters, wordCount: 0 };
  book.wordCount = countWords(chapters);
  return { book, files };
}
