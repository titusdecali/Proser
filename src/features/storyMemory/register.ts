/** VS Code wiring for Story Memory: the singleton engine, the build/rebuild/
 *  choose-folder commands, the once-per-project first-load prompt, and the
 *  debounced incremental update on chapter save. §8.6, §9. */
import * as vscode from 'vscode';
import { Commands } from '../../constants';
import { StoryMemoryEngine, setActiveEngine } from './engine';
import { isMemoryError } from '../ai/engineFactory';
import { anchorFolder, hasConfiguredRoot, setStoryRoot } from './scope';
import { activeMarkdownDoc } from '../manuscript/compile';

const SAVE_DEBOUNCE_MS = 2000;

/** Surfaces a scan failure, with a tailored hint + "Choose a model" action when
 *  the model ran out of memory (the common cause on a tight-RAM machine). */
async function showScanError(e: unknown): Promise<void> {
  if (isMemoryError(e)) {
    const pick = await vscode.window.showErrorMessage(
      'Story Memory scan ran out of memory running the AI model. Try a smaller AI model in Proser Settings → AI Model.',
      'Choose a model'
    );
    if (pick === 'Choose a model') {
      void vscode.commands.executeCommand(Commands.aiSelectLocalModel);
    }
    return;
  }
  void vscode.window.showErrorMessage(`Story Memory scan failed: ${e instanceof Error ? e.message : String(e)}`);
}

export function registerStoryMemory(context: vscode.ExtensionContext): void {
  const engine = new StoryMemoryEngine();
  setActiveEngine(engine);

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.storyMemoryChooseFolder, () => chooseStoryFolder()),
    vscode.commands.registerCommand(Commands.storyMemoryBuild, () => buildCmd(engine, false)),
    vscode.commands.registerCommand(Commands.storyMemoryRebuild, () => buildCmd(engine, true)),
    vscode.commands.registerCommand(Commands.storyMemoryRescanChapter, () => rescanChapterCmd(engine))
  );

  // First time this project opens without a Story Folder, ask once which folder
  // holds the manuscript (so Chapters + Brainstorm canon point at chapters, not notes).
  void maybePromptStoryRoot(context);

  // Incremental re-extract when a canonical chapter is saved (debounced per file).
  // Only active once the author has opted into a Story Root.
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== 'markdown' || doc.uri.scheme !== 'file') {
        return;
      }
      const key = doc.uri.toString();
      const prev = pending.get(key);
      if (prev) {
        clearTimeout(prev);
      }
      pending.set(
        key,
        setTimeout(async () => {
          pending.delete(key);
          if (!(await hasConfiguredRoot())) {
            return;
          }
          try {
            await engine.updateChapter(doc.uri);
          } catch {
            /* best-effort background update */
          }
        }, SAVE_DEBOUNCE_MS)
      );
    }),
    { dispose: () => pending.forEach((t) => clearTimeout(t)) }
  );
}

/** Folder picker → persist as the Story Root. Returns true when set. */
async function chooseStoryFolder(): Promise<boolean> {
  const anchor = anchorFolder();
  const picked = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    defaultUri: anchor,
    openLabel: 'Use as Story Folder',
    title: 'Pick your manuscript folder (canon — not notes or research)'
  });
  if (!picked?.length) {
    return false;
  }
  const scope = await setStoryRoot(picked[0]);
  if (scope) {
    const name = scope.rel === '.' ? anchor?.path.split('/').pop() ?? 'workspace' : scope.rel;
    void vscode.window.showInformationMessage(
      `Story folder set to “${name}”. Run “Proser: Build Story Memory” to index it.`
    );
    void vscode.commands.executeCommand(Commands.chaptersRefresh); // Chapters list follows the new root
  }
  return !!scope;
}

const STORY_PROMPT_KEY = 'proser.storyMemory.firstLoadPrompted';

/** On a fresh project with no Story Root yet, ask once which folder holds the
 *  manuscript — so the Chapters list and Brainstorm canon point at the chapters,
 *  not whatever notes sit in the workspace root. Asked at most once per project
 *  (a dismissal won't nag on the next launch); the author can always set it later
 *  from Settings → Story Memory. */
async function maybePromptStoryRoot(context: vscode.ExtensionContext): Promise<void> {
  if (context.workspaceState.get<boolean>(STORY_PROMPT_KEY)) {
    return; // already asked for this project
  }
  if (!anchorFolder() || (await hasConfiguredRoot())) {
    return; // no workspace folder, or the author already chose a root
  }
  // Only nudge in folders that actually contain Markdown (a writing project).
  const md = await vscode.workspace.findFiles(
    '**/*.md',
    '{**/node_modules/**,**/.git/**,**/.proser/**}',
    1
  );
  if (md.length === 0) {
    return;
  }
  await context.workspaceState.update(STORY_PROMPT_KEY, true);
  await ensureStoryRoot();
}

/** Once-per-project first-load prompt; carries the canon-vs-notes guidance. */
async function ensureStoryRoot(): Promise<boolean> {
  if (await hasConfiguredRoot()) {
    return true;
  }
  const anchor = anchorFolder();
  if (!anchor) {
    void vscode.window.showWarningMessage('Open your writing folder first.');
    return false;
  }
  const name = anchor.path.split('/').pop() || 'this folder';
  const pick = await vscode.window.showInformationMessage(
    `Set “${name}” as your Story folder? Pick the folder with your ACTUAL manuscript chapters — not notes or research, which can make the AI hallucinate.`,
    'Use this folder',
    'Choose…'
  );
  if (pick === 'Use this folder') {
    const scope = await setStoryRoot(anchor);
    if (scope) {
      void vscode.commands.executeCommand(Commands.chaptersRefresh); // Chapters list follows the new root
    }
    return !!scope;
  }
  if (pick === 'Choose…') {
    return chooseStoryFolder();
  }
  return false;
}

async function buildCmd(engine: StoryMemoryEngine, rebuild: boolean): Promise<void> {
  if (!(await ensureStoryRoot())) {
    return;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: rebuild ? 'Rebuilding Story Memory…' : 'Building Story Memory…',
      cancellable: true
    },
    async (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());
      try {
        const res = rebuild
          ? await engine.rebuild(progress, ac.signal)
          : await engine.build(progress, ac.signal);
        void vscode.window.showInformationMessage(
          `Story Memory: ${res.built} indexed, ${res.skipped} unchanged` +
            (res.failed ? `, ${res.failed} failed` : '') +
            ` (of ${res.total}).`
        );
      } catch (e) {
        await showScanError(e);
      }
    }
  );
}

/** Re-extract just the active chapter into Story Memory (the "Rescan Active Page"
 *  option) — cheap incremental update for the file you're working on. */
async function rescanChapterCmd(engine: StoryMemoryEngine): Promise<void> {
  if (!(await ensureStoryRoot())) {
    return;
  }
  const doc = activeMarkdownDoc();
  if (!doc) {
    void vscode.window.showInformationMessage('Open a chapter first, then re-scan it.');
    return;
  }
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Re-scanning this chapter…' },
    async () => {
      try {
        const updated = await engine.updateChapter(doc.uri);
        void vscode.window.showInformationMessage(
          updated
            ? 'Story Memory: this chapter re-scanned.'
            : 'Story Memory: this file is not a canon chapter (nothing to re-scan).'
        );
      } catch (e) {
        await showScanError(e);
      }
    }
  );
}
