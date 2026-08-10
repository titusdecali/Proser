/** Turns a folder of chapter `.md` files into a BookModel: files are taken in
 *  lexical (filename) order — the repo convention where the sort *is* the
 *  reading order — minus a configurable exclude list of reference files. */
import * as vscode from 'vscode';
import { EXTENSION_ID, MARKDOWN_LANGUAGE_ID, VIEW_TYPE_MARKDOWN_EDITOR } from '../../constants';
import { BookModel, Chapter, ManuscriptMeta, countWords, parseChapter } from './model';
import { MANUSCRIPT_META_FILE } from './config';
// NOTE: scope.ts also imports helpers from this module. The cycle is safe — both
// sides only call the other's hoisted functions at runtime, never at module load.
import { getStoryScope, hasConfiguredRoot } from '../storyMemory/scope';

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

/** Last Markdown doc that was genuinely active — the fallback when focus moves to
 *  a Proser webview (sidebar/editor-tab panel), which isn't a text editor. */
let lastActiveMarkdownDoc: vscode.TextDocument | undefined;

/** The Markdown document the user is currently looking at, raw editor or pretty. */
export function activeMarkdownDoc(): vscode.TextDocument | undefined {
  const editor = vscode.window.activeTextEditor;
  if (editor && editor.document.languageId === MARKDOWN_LANGUAGE_ID) {
    lastActiveMarkdownDoc = editor.document;
    return editor.document;
  }
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE_MARKDOWN_EDITOR) {
    const key = input.uri.toString();
    const found = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    if (found) {
      lastActiveMarkdownDoc = found;
      return found;
    }
  }
  // Focus is on a non-editor surface (e.g. the Proser checks/Brainstorm tab or the
  // sidebar): keep operating on the Markdown doc the user was last in, as long as
  // it's still open. Without this, running a check or spell scan from the Proser
  // editor-tab panel would resolve no document and silently scan nothing.
  if (lastActiveMarkdownDoc && !lastActiveMarkdownDoc.isClosed) {
    return lastActiveMarkdownDoc;
  }
  return undefined;
}

/** Last successfully-resolved manuscript folder — keeps every consumer stable
 *  when the author closes ALL editor tabs (the active-doc chain goes dark). */
let lastManuscriptFolder: vscode.Uri | undefined;

/**
 * The folder whose chapters we compile. Must never depend on an editor being
 * open — closing the last tab used to blank the Chapters view and point exports
 * at the workspace root. Resolution chain:
 *   1. the active Markdown file's directory (remembered for later),
 *   2. the remembered folder from earlier this session (validated: still inside
 *      the workspace and still on disk),
 *   3. the persisted Story Root (`.proser/config.json`), when configured,
 *   4. the folder holding a `.proser-manuscript.json` marker — the title-page
 *      metadata always lives next to the chapters,
 *   5. the first workspace folder (the original fallback).
 */
export async function manuscriptFolder(): Promise<vscode.Uri | undefined> {
  const doc = activeMarkdownDoc();
  if (doc && doc.uri.scheme === 'file') {
    lastManuscriptFolder = vscode.Uri.joinPath(doc.uri, '..');
    return lastManuscriptFolder;
  }
  if (lastManuscriptFolder && vscode.workspace.getWorkspaceFolder(lastManuscriptFolder)) {
    try {
      await vscode.workspace.fs.stat(lastManuscriptFolder);
      return lastManuscriptFolder;
    } catch {
      lastManuscriptFolder = undefined; // deleted/renamed — fall through
    }
  }
  if (await hasConfiguredRoot()) {
    const root = (await getStoryScope())?.root;
    if (root) {
      return root;
    }
  }
  try {
    const markers = await vscode.workspace.findFiles(`**/${MANUSCRIPT_META_FILE}`, '**/node_modules/**', 2);
    if (markers.length > 0) {
      // Deterministic pick when a workspace holds several manuscripts; authors
      // with more than one should set a Story Root, which wins above.
      markers.sort((a, b) => a.path.localeCompare(b.path, 'en'));
      lastManuscriptFolder = vscode.Uri.joinPath(markers[0], '..');
      return lastManuscriptFolder;
    }
  } catch {
    /* search unavailable — fall through */
  }
  return vscode.workspace.workspaceFolders?.[0]?.uri;
}

/** The view column where `uri` is currently open (Pretty custom editor or raw
 *  text editor), if any — so reveal / "Go To" can target the existing tab rather
 *  than duplicating the file into whatever group happens to be active (e.g. the
 *  Proser panel's). Returns undefined when the file isn't open anywhere. */
export function columnForOpenUri(uri: vscode.Uri): vscode.ViewColumn | undefined {
  const key = uri.toString();
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const input = tab.input;
      if (
        (input instanceof vscode.TabInputCustom && input.uri.toString() === key) ||
        (input instanceof vscode.TabInputText && input.uri.toString() === key)
      ) {
        return group.viewColumn;
      }
    }
  }
  return undefined;
}

/** Combined reference-file exclusion (defaults + user config), lowercased. Used
 *  to keep non-manuscript files (notes, bible, …) out of the compile AND out of
 *  the Story Memory canon fold. */
export function referenceExcludeSet(): string[] {
  const extra = vscode.workspace
    .getConfiguration(EXTENSION_ID)
    .get<string[]>('manuscript.exclude', []);
  return [...DEFAULT_EXCLUDE, ...extra].map((s) => s.toLowerCase());
}

/** True when `base` (a filename without extension) is a reference file to skip. */
export function isReferenceBasename(base: string, exclude = referenceExcludeSet()): boolean {
  const b = base.toLowerCase();
  return exclude.some((ex) => b === ex || b.startsWith(ex));
}

function excludeSet(): string[] {
  return referenceExcludeSet();
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

/** Compiles a specific, ordered list of chapter files into a book. Empty files
 *  are skipped. Used for both whole-folder and single-file ("active") exports. */
export async function compileChapters(
  uris: vscode.Uri[],
  meta: ManuscriptMeta
): Promise<CompileResult> {
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

export async function compileBook(
  folder: vscode.Uri,
  meta: ManuscriptMeta
): Promise<CompileResult> {
  return compileChapters(await gatherChapterFiles(folder), meta);
}
