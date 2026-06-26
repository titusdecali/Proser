import * as vscode from 'vscode';
import { Commands, VIEW_TYPE_CHAPTERS, VIEW_TYPE_MARKDOWN_EDITOR } from '../../constants';
import { activeMarkdownDoc, gatherChapterFiles, manuscriptFolder, titleFromFilename } from './compile';
import { getStoryScope, hasConfiguredRoot, listStoryFiles } from '../storyMemory/scope';

/** One chapter file. Clicking it opens the chapter in the Pretty editor; the
 *  one you're currently viewing is highlighted. */
class ChapterItem extends vscode.TreeItem {
  constructor(uri: vscode.Uri, active: boolean) {
    const file = uri.path.split('/').pop() ?? '';
    super(titleFromFilename(file) || file, vscode.TreeItemCollapsibleState.None);
    this.resourceUri = uri;
    this.description = file;
    this.tooltip = uri.fsPath;
    this.iconPath = active
      ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.blue'))
      : new vscode.ThemeIcon('book');
    this.command = {
      command: Commands.openChapter,
      title: 'Open Chapter',
      arguments: [uri]
    };
  }
}

/** Lists the manuscript folder's chapter files (the same ordered set the export
 *  uses), so the author can see and jump between chapters from the Proser
 *  sidebar — no file Explorer needed. */
class ChaptersProvider implements vscode.TreeDataProvider<ChapterItem> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  refresh(): void {
    this.changed.fire();
  }

  getTreeItem(item: ChapterItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<ChapterItem[]> {
    const activeKey = activeMarkdownDoc()?.uri.toString();
    try {
      // Prefer the configured Story Folder so the list shows the actual manuscript
      // chapters — not whatever folder the active file sits in (which defaults to
      // the workspace root, i.e. notes/research). Falls back to the active/root
      // folder only when no Story Folder has been set.
      let files: vscode.Uri[];
      if (await hasConfiguredRoot()) {
        const scope = await getStoryScope();
        files = scope ? await listStoryFiles(scope.root) : [];
      } else {
        const folder = manuscriptFolder();
        files = folder ? await gatherChapterFiles(folder) : [];
      }
      return files.map((u) => new ChapterItem(u, u.toString() === activeKey));
    } catch {
      return []; // folder unreadable (e.g. nothing open yet)
    }
  }
}

/** Whether the editor supports placing a view in the secondary side bar — the
 *  reliable secondary-sidebar view placement landed in VS Code 1.106. (Cursor
 *  1.105.x and other forks below 1.106 can't, so we don't offer a move there.) */
function supportsSecondarySidebar(): boolean {
  const [major, minor] = vscode.version.split('.').map((n) => parseInt(n, 10) || 0);
  return major > 1 || (major === 1 && minor >= 106);
}

export function registerChaptersView(context: vscode.ExtensionContext): void {
  const provider = new ChaptersProvider();
  const refresh = (): void => provider.refresh();
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');

  // Mirror the file Explorer's preview behavior: a single click opens the chapter as
  // a PREVIEW tab (italic — replaced by the next single click), a double click (a
  // second click on the same item within 500ms) opens it PINNED. Editing or
  // double-clicking the tab also pins it (VS Code handles that natively).
  let lastClick = { uri: '', time: 0 };
  const openChapter = async (uri: vscode.Uri): Promise<void> => {
    const key = uri.toString();
    const now = Date.now();
    const isDouble = key === lastClick.uri && now - lastClick.time < 500;
    lastClick = { uri: key, time: now };
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE_MARKDOWN_EDITOR, {
      preview: !isDouble, // single click → preview (honored only when workbench.editor.enablePreview is on)
      // Reuse the current editor group. Without this, clicking from the Chapters
      // tree (focus in the sidebar) lets VS Code pick a group — when the editor is
      // split it lands in the OTHER group, opening the chapter in a separate tab
      // instead of replacing the one you're reading.
      viewColumn: vscode.ViewColumn.Active
    });
  };

  context.subscriptions.push(
    vscode.window.createTreeView(VIEW_TYPE_CHAPTERS, { treeDataProvider: provider }),
    watcher,
    watcher.onDidCreate(refresh), // new chapter file
    watcher.onDidDelete(refresh), // removed chapter
    vscode.window.onDidChangeActiveTextEditor(refresh), // folder + active highlight follow you
    vscode.window.tabGroups.onDidChangeTabs(refresh), // Pretty-tab switches
    vscode.commands.registerCommand(Commands.chaptersRefresh, refresh),
    vscode.commands.registerCommand(Commands.openChapter, openChapter),

    // VS Code can't *default* a container to the right (secondary) side bar, but
    // this focuses the Proser panel and opens the built-in "move view" picker —
    // choose "Secondary Side Bar" and it sticks. One click, no fragile dragging.
    // We focus the Chapters TREE view (a webview's focus goes into its iframe, so
    // the workbench reports "no view focused"), and let the focus land first.
    vscode.commands.registerCommand(Commands.moveToSide, async () => {
      if (!supportsSecondarySidebar()) {
        void vscode.window.showInformationMessage(
          'The right (secondary) side bar needs VS Code 1.106+. On older editors (e.g. Cursor 1.105) use the Chapters panel in the Proser sidebar instead.'
        );
        return;
      }
      try {
        // VS Code has NO command to move a whole view container — only dragging
        // the activity-bar icon does that. So open the built-in, focus-free
        // "Move View" picker (choose a Proser view → "Secondary Side Bar"); the
        // prompt copy tells users to drag the icon to move the entire panel.
        await vscode.commands.executeCommand('workbench.action.moveView');
      } catch {
        void vscode.window.showInformationMessage(
          'Drag the Proser icon (left activity bar) into the right side bar to dock the whole panel — or run “View: Move View” → pick a Proser view → “Secondary Side Bar”.'
        );
      }
    })
  );
}
