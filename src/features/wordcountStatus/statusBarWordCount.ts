import * as vscode from 'vscode';
import {
  Commands,
  ConfigKeys,
  EXTENSION_ID,
  MARKDOWN_LANGUAGE_ID,
  VIEW_TYPE_MARKDOWN_EDITOR
} from '../../constants';
import { createKeyedDebouncer } from '../../util/debounce';
import { computeProseStats, countTokens, estimateReadingMinutes, ProseStats } from '../../util/wordcount';
import { ScanOptions } from '../../util/markdownScan';
import { wordcountScanOptions } from '../../util/scanConfig';

const GOAL_STATE_PREFIX = 'proser.wordGoal:';

/**
 * Bottom-left status-bar stats for the active Markdown document — word, char,
 * and reading-time counts, a per-document goal, and a rich hover breakdown.
 * Resolves the document from the active text editor OR the active Proser
 * pretty-view tab, so the stats stay visible in either view.
 */
export function registerStatusBarWordCount(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = Commands.showWordStats;
  context.subscriptions.push(item);

  const debouncer = createKeyedDebouncer(400);
  context.subscriptions.push({ dispose: () => debouncer.dispose() });

  const statsCache = new Map<string, ProseStats>();

  function goalKey(doc: vscode.TextDocument): string {
    return GOAL_STATE_PREFIX + doc.uri.toString();
  }
  function getGoal(doc: vscode.TextDocument): number | undefined {
    return context.workspaceState.get<number>(goalKey(doc));
  }

  function getStats(doc: vscode.TextDocument, opts: ScanOptions): ProseStats {
    const key = doc.uri.toString();
    const cached = statsCache.get(key);
    if (cached) {
      return cached;
    }
    const stats = computeProseStats(doc.getText(), opts);
    statsCache.set(key, stats);
    return stats;
  }

  /** The active Markdown document — from a text editor or the pretty-view tab. */
  function activeMarkdownDoc(): vscode.TextDocument | undefined {
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

  function hoverTooltip(stats: ProseStats, minutes: number, goal?: number): vscode.MarkdownString {
    const md = new vscode.MarkdownString();
    md.appendMarkdown('**Document stats**\n\n');
    md.appendMarkdown(`- Words: ${stats.words.toLocaleString()}\n`);
    md.appendMarkdown(
      `- Characters: ${stats.characters.toLocaleString()} (${stats.charactersNoSpaces.toLocaleString()} without spaces)\n`
    );
    md.appendMarkdown(`- Sentences: ${stats.sentences.toLocaleString()}\n`);
    md.appendMarkdown(`- Paragraphs: ${stats.paragraphs.toLocaleString()}\n`);
    md.appendMarkdown(`- Reading time: ~${minutes} min\n`);
    if (goal && goal > 0) {
      const pct = Math.min(999, Math.round((stats.words / goal) * 100));
      md.appendMarkdown(`- Goal: ${goal.toLocaleString()} words (${pct}%)\n`);
    }
    md.appendMarkdown('\n_Click for the full breakdown._');
    return md;
  }

  function render(): void {
    const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
    if (!cfg.get<boolean>(ConfigKeys.wordcountStatusBarEnabled, true)) {
      item.hide();
      return;
    }
    const doc = activeMarkdownDoc();
    if (!doc) {
      item.hide();
      return;
    }

    const opts = wordcountScanOptions();
    const wpm = cfg.get<number>(ConfigKeys.wordcountWordsPerMinute, 200);
    const stats = getStats(doc, opts);
    const minutes = estimateReadingMinutes(stats.words, wpm);

    // Selected-word readout when a text editor of this doc has a selection.
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document === doc) {
      const selectedText = editor.selections
        .filter((s) => !s.isEmpty)
        .map((s) => doc.getText(s))
        .join(' ');
      if (selectedText.trim().length > 0) {
        const selected = countTokens(selectedText);
        item.text = `$(book) ${selected.toLocaleString()} of ${stats.words.toLocaleString()} words selected`;
        item.tooltip = hoverTooltip(stats, minutes, getGoal(doc));
        item.show();
        return;
      }
    }

    const goal = getGoal(doc);
    if (goal && goal > 0) {
      const pct = Math.min(999, Math.round((stats.words / goal) * 100));
      const done = stats.words >= goal ? ' $(check)' : '';
      item.text = `$(book) ${stats.words.toLocaleString()} / ${goal.toLocaleString()} words (${pct}%)${done} · ${minutes} min read`;
    } else {
      item.text = `$(book) ${stats.words.toLocaleString()} words · ${stats.characters.toLocaleString()} chars · ${minutes} min read`;
    }
    item.tooltip = hoverTooltip(stats, minutes, goal);
    item.show();
  }

  function invalidate(doc: vscode.TextDocument): void {
    statsCache.delete(doc.uri.toString());
    debouncer.schedule('render', render);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.setWordGoal, async () => {
      const doc = activeMarkdownDoc();
      if (!doc) {
        vscode.window.showInformationMessage('Open a Markdown file to set a word goal.');
        return;
      }
      const current = getGoal(doc);
      const input = await vscode.window.showInputBox({
        prompt: 'Word goal for this document (leave empty to clear)',
        value: current ? String(current) : '',
        validateInput: (v) => {
          if (v.trim() === '') {
            return null;
          }
          const n = Number(v);
          return Number.isInteger(n) && n > 0 ? null : 'Enter a positive whole number.';
        }
      });
      if (input === undefined) {
        return;
      }
      await context.workspaceState.update(goalKey(doc), input.trim() === '' ? undefined : Number(input));
      render();
    }),

    vscode.commands.registerCommand(Commands.showWordStats, () => {
      const doc = activeMarkdownDoc();
      if (!doc) {
        vscode.window.showInformationMessage('Open a Markdown file to see its stats.');
        return;
      }
      const opts = wordcountScanOptions();
      const stats = getStats(doc, opts);
      const wpm = vscode.workspace
        .getConfiguration(EXTENSION_ID)
        .get<number>(ConfigKeys.wordcountWordsPerMinute, 200);
      const minutes = estimateReadingMinutes(stats.words, wpm);
      const detail = [
        `Words:        ${stats.words.toLocaleString()}`,
        `Characters:   ${stats.characters.toLocaleString()} (${stats.charactersNoSpaces.toLocaleString()} without spaces)`,
        `Sentences:    ${stats.sentences.toLocaleString()}`,
        `Paragraphs:   ${stats.paragraphs.toLocaleString()}`,
        `Reading time: ~${minutes} min`
      ].join('\n');
      vscode.window.showInformationMessage('Proser — Document Stats', { modal: true, detail });
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => render()),
    vscode.window.onDidChangeTextEditorSelection(() => render()),
    vscode.window.tabGroups.onDidChangeTabs(() => render()),
    vscode.window.tabGroups.onDidChangeTabGroups(() => render()),
    vscode.workspace.onDidChangeTextDocument((e) => invalidate(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => statsCache.delete(doc.uri.toString())),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(EXTENSION_ID)) {
        statsCache.clear();
        render();
      }
    })
  );

  render();
}
