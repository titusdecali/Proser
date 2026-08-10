import * as vscode from 'vscode';
import {
  Commands,
  ConfigKeys,
  EXTENSION_ID,
  MARKDOWN_LANGUAGE_ID,
  STATE_DAILY_GOAL_BASELINE,
  STATE_DAILY_GOAL_CELEBRATED
} from '../../constants';
import { createKeyedDebouncer } from '../../util/debounce';
import { countMarkdownWords } from '../../util/wordcount';
import { wordcountScanOptions } from '../../util/scanConfig';
import { getStoryScope, hasConfiguredRoot, listStoryFiles } from '../storyMemory/scope';
import { gatherChapterFiles, manuscriptFolder } from '../manuscript/compile';
import { showCelebrationCard } from './celebrationPanel';

/** Start-of-day snapshot of the whole-manuscript word count. Today's words
 *  written = current total − baseline.total (net: deletions subtract). */
interface DayBaseline {
  date: string; // local 'YYYY-MM-DD'
  total: number;
}

const DEFAULT_TARGET = 500;
const EDIT_DEBOUNCE_MS = 500;
const RESCAN_DEBOUNCE_MS = 2000;
/** How often to re-check the calendar date so the counter rolls over to 0 at
 *  midnight even when no edits happen. */
const DAY_TICK_MS = 60_000;

/** Local calendar date — a writer's "today" follows their clock, not UTC
 *  (toISOString would flip the day early/late depending on timezone). */
function todayKey(): string {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * Bottom-right status-bar counter for words written TODAY across ALL manuscript
 * files (the same file set as the Chapters navigator), with a configurable daily
 * target. Clicking it opens a quick menu to set the target without visiting
 * Settings. Crossing the target pops a one-per-day celebration card.
 */
export function registerDailyGoal(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.name = 'Proser Daily Words';
  item.command = Commands.dailyGoalMenu;
  context.subscriptions.push(item);

  const debouncer = createKeyedDebouncer(EDIT_DEBOUNCE_MS);
  const rescanDebouncer = createKeyedDebouncer(RESCAN_DEBOUNCE_MS);
  context.subscriptions.push({
    dispose: () => {
      debouncer.dispose();
      rescanDebouncer.dispose();
    }
  });

  /** Per-file word counts for every manuscript file (uri string → words). */
  let counts = new Map<string, number>();
  let total = 0;
  let ready = false; // true once the first full scan completed
  let baseline = context.workspaceState.get<DayBaseline>(STATE_DAILY_GOAL_BASELINE);
  /** Story-root path from the last scan, to filter save events cheaply. */
  let lastRootPath: string | undefined;
  let scanGen = 0; // invalidates in-flight scans superseded by a newer one

  function getTarget(): number {
    return vscode.workspace
      .getConfiguration(EXTENSION_ID)
      .get<number>(ConfigKeys.dailyGoalTarget, DEFAULT_TARGET);
  }

  function sumCounts(): number {
    let t = 0;
    for (const n of counts.values()) {
      t += n;
    }
    return t;
  }

  /** The manuscript file set — the same resolution the Chapters navigator uses:
   *  the configured Story Folder (recursive) when set, else the manuscript
   *  folder's flat chapter list. */
  async function storyFiles(): Promise<vscode.Uri[]> {
    if (await hasConfiguredRoot()) {
      const scope = await getStoryScope();
      lastRootPath = scope?.root.path.replace(/\/+$/, '');
      return scope ? await listStoryFiles(scope.root) : [];
    }
    const folder = await manuscriptFolder();
    lastRootPath = folder?.path.replace(/\/+$/, '');
    return folder ? await gatherChapterFiles(folder) : [];
  }

  /** Re-counts every manuscript file from open docs (unsaved edits count) or
   *  disk. Generation-guarded so a stale scan never clobbers a newer one. */
  async function fullScan(): Promise<void> {
    const gen = ++scanGen;
    let files: vscode.Uri[];
    try {
      files = await storyFiles();
    } catch {
      files = [];
    }
    const opts = wordcountScanOptions();
    const next = new Map<string, number>();
    for (const uri of files) {
      if (gen !== scanGen) {
        return;
      }
      const key = uri.toString();
      try {
        const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
        const text = open
          ? open.getText()
          : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
        next.set(key, countMarkdownWords(text, opts));
      } catch {
        /* unreadable file — skip */
      }
    }
    if (gen !== scanGen) {
      return;
    }
    counts = next;
    ready = true;
    await afterCountsChanged();
  }

  /** Re-baselines when the calendar date changed (first run, next morning, or
   *  midnight rollover while the window stayed open). */
  async function refreshDay(): Promise<void> {
    const today = todayKey();
    if (!baseline || baseline.date !== today) {
      baseline = { date: today, total };
      await context.workspaceState.update(STATE_DAILY_GOAL_BASELINE, baseline);
    }
  }

  async function maybeCelebrate(): Promise<void> {
    const target = getTarget();
    if (!ready || !baseline || target <= 0) {
      return;
    }
    if (total - baseline.total < target) {
      return;
    }
    const today = todayKey();
    if (context.workspaceState.get<string>(STATE_DAILY_GOAL_CELEBRATED) === today) {
      return;
    }
    await context.workspaceState.update(STATE_DAILY_GOAL_CELEBRATED, today);
    showCelebrationCard(context, total - baseline.total, target);
  }

  async function afterCountsChanged(): Promise<void> {
    total = sumCounts();
    await refreshDay();
    await maybeCelebrate();
    render();
  }

  function progressBar(pct: number): string {
    const filled = Math.max(0, Math.min(10, Math.round(pct / 10)));
    return '▰'.repeat(filled) + '▱'.repeat(10 - filled);
  }

  function hoverTooltip(written: number, target: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**Words written today** (whole manuscript)\n\n');
    md.appendMarkdown(`- Today: ${written.toLocaleString()} words\n`);
    if (target > 0) {
      const pct = Math.max(0, Math.round((written / target) * 100));
      md.appendMarkdown(`- Target: ${target.toLocaleString()} words\n`);
      md.appendMarkdown(`- Progress: ${progressBar(pct)} ${pct}%\n`);
    }
    md.appendMarkdown(`- Manuscript: ${total.toLocaleString()} words across ${counts.size} files\n`);
    if (written < 0) {
      md.appendMarkdown('\n_Negative = you deleted more than you wrote (net count)._\n');
    }
    md.appendMarkdown('\n_Click to set your daily target._');
    return md;
  }

  function render(): void {
    const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
    if (!cfg.get<boolean>(ConfigKeys.dailyGoalEnabled, true) || !ready || !baseline || counts.size === 0) {
      item.hide();
      return;
    }
    const written = total - baseline.total;
    const target = getTarget();
    const w = written.toLocaleString();
    if (target > 0) {
      const hit = written >= target;
      item.text = hit
        ? `$(check) Word Goal: ${w} / ${target.toLocaleString()} today 🎉`
        : `$(flame) Word Goal: ${w} / ${target.toLocaleString()} today`;
    } else {
      item.text = `$(flame) ${w} words today`;
    }
    item.tooltip = hoverTooltip(written, target);
    item.show();
  }

  function scheduleRescan(): void {
    rescanDebouncer.schedule('rescan', () => void fullScan());
  }

  // ── Commands ─────────────────────────────────────────────────────────────

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.dailyGoalSetTarget, async () => {
      const current = getTarget();
      const input = await vscode.window.showInputBox({
        prompt: 'Daily word target across the whole manuscript (leave empty or 0 to just count words)',
        value: current > 0 ? String(current) : '',
        validateInput: (v) => {
          if (v.trim() === '') {
            return null;
          }
          const n = Number(v);
          return Number.isInteger(n) && n >= 0 ? null : 'Enter a whole number (0 clears the target).';
        }
      });
      if (input === undefined) {
        return;
      }
      const n = input.trim() === '' ? 0 : Number(input);
      const hasWorkspace = (vscode.workspace.workspaceFolders?.length ?? 0) > 0;
      await vscode.workspace
        .getConfiguration(EXTENSION_ID)
        .update(
          ConfigKeys.dailyGoalTarget,
          n,
          hasWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global
        );
      await afterCountsChanged();
    }),

    vscode.commands.registerCommand(Commands.dailyGoalMenu, async () => {
      const target = getTarget();
      const written = ready && baseline ? total - baseline.total : 0;
      type Item = vscode.QuickPickItem & { action: 'set' | 'stats' | 'rescan' };
      const items: Item[] = [
        {
          label: '$(target) Set daily word target…',
          detail:
            target > 0
              ? `Current target: ${target.toLocaleString()} words per day`
              : 'No target set — counting words only',
          action: 'set'
        },
        {
          label: '$(graph) Today so far',
          detail: `${written.toLocaleString()} words written today · manuscript total ${total.toLocaleString()} words`,
          action: 'stats'
        },
        {
          label: '$(refresh) Recalculate from disk',
          detail: 'Re-scan every manuscript file (use after changes made outside VS Code)',
          action: 'rescan'
        }
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Proser — daily words' });
      if (!pick) {
        return;
      }
      if (pick.action === 'set') {
        await vscode.commands.executeCommand(Commands.dailyGoalSetTarget);
      } else if (pick.action === 'rescan') {
        await fullScan();
        vscode.window.setStatusBarMessage('$(check) Proser: daily word count recalculated', 4000);
      } else {
        const pct = target > 0 ? Math.max(0, Math.round((written / target) * 100)) : undefined;
        const detail = [
          `Written today:    ${written.toLocaleString()} words`,
          target > 0 ? `Daily target:     ${target.toLocaleString()} words (${pct}%)` : `Daily target:     none`,
          `Manuscript total: ${total.toLocaleString()} words across ${counts.size} files`
        ].join('\n');
        vscode.window.showInformationMessage('Proser — Today’s Writing', { modal: true, detail });
      }
    })
  );

  // ── Listeners ────────────────────────────────────────────────────────────

  context.subscriptions.push(
    // Live recount of the edited file only (the rest of the totals are cached).
    vscode.workspace.onDidChangeTextDocument((e) => {
      const doc = e.document;
      if (doc.languageId !== MARKDOWN_LANGUAGE_ID || doc.uri.scheme !== 'file') {
        return;
      }
      const key = doc.uri.toString();
      if (!counts.has(key)) {
        return; // not a manuscript file (new files enter via create/save rescan)
      }
      debouncer.schedule(key, () => {
        counts.set(key, countMarkdownWords(doc.getText(), wordcountScanOptions()));
        void afterCountsChanged();
      });
    }),

    // A saved Markdown file we don't track yet may be a brand-new chapter —
    // rescan when it plausibly lives in the manuscript.
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.languageId !== MARKDOWN_LANGUAGE_ID || doc.uri.scheme !== 'file') {
        return;
      }
      if (counts.has(doc.uri.toString())) {
        return; // already tracked; the change listener handled the count
      }
      if (!lastRootPath || doc.uri.path.startsWith(lastRootPath + '/')) {
        scheduleRescan();
      }
    }),

    // Chapter files added/removed/renamed → refresh the tracked set.
    vscode.workspace.onDidCreateFiles(() => scheduleRescan()),
    vscode.workspace.onDidDeleteFiles(() => scheduleRescan()),
    vscode.workspace.onDidRenameFiles(() => scheduleRescan()),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${EXTENSION_ID}.wordcount`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.manuscript.exclude`)
      ) {
        scheduleRescan(); // counting rules or file set changed
      } else if (e.affectsConfiguration(`${EXTENSION_ID}.dailyGoal`)) {
        void afterCountsChanged();
      }
    })
  );

  // Midnight rollover: reset the counter to 0 even when the window sits idle.
  const dayTick = setInterval(() => void afterCountsChanged(), DAY_TICK_MS);
  context.subscriptions.push({ dispose: () => clearInterval(dayTick) });

  void fullScan();
}
