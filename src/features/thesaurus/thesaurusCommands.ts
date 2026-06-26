import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID, MARKDOWN_LANGUAGE_ID } from '../../constants';
import { fetchFromDatamuse, ThesaurusKind } from './datamuseClient';
import { fetchFromWordNet } from './offlineThesaurus';
import { getSynonymsEngine } from '../ai/engineFactory';
import { aiContextSuggestions } from '../ai/aiSynonyms';
import { currentModelName } from '../ai/aiModelStatus';

type Source = 'online' | 'offline' | 'auto';
type AiMode = 'ask' | 'ai' | 'local';
/** A single user-facing engine choice (collapses aiMode + dictionary source). */
type EngineChoice = 'ai' | 'online' | 'offline' | 'auto' | 'ask';
/** Where the suggestions actually came from, for transparent UI. */
type LookupSource = 'ai' | 'online' | 'offline' | 'none';
/** Why the AI path did or didn't produce results — drives actionable messaging. */
type AiStatus = 'ok' | 'off' | 'not-ready' | 'timeout' | 'error' | 'empty' | 'skipped';

/** Diagnostic log (View → Output → "Proser") so lookups are never a black box. */
let output: vscode.OutputChannel | undefined;
function log(line: string): void {
  output?.appendLine(`${new Date().toLocaleTimeString()}  ${line}`);
}

const AI_MODE_CONTEXT_KEY = 'proser.thesaurus.aiMode';

interface PendingSuggestions {
  uri: string;
  range: vscode.Range;
  word: string;
  items: string[];
  detail: string;
}

// Suggestions for the most recent lookup, surfaced through the suggest widget
// so the list appears in a dropdown anchored at the word (not the top-center
// QuickPick). Cleared as soon as the document changes.
let pending: PendingSuggestions | undefined;

export function registerThesaurus(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Proser');
  context.subscriptions.push(output);

  // Keep a context key in sync with the mode so the right-click menu can show
  // "Use AI…" vs "Use Local Dictionary…".
  syncAiModeContext();

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.synonyms, () => runThesaurus('synonyms')),
    vscode.commands.registerCommand(Commands.antonyms, () => runThesaurus('antonyms')),
    vscode.commands.registerCommand(Commands.useAiSynonyms, () => enableAi()),
    vscode.commands.registerCommand(Commands.useLocalSynonyms, async () => {
      await setAiMode('local');
      vscode.window.setStatusBarMessage(
        '$(book) Proser: synonyms now use the local dictionary.',
        3000
      );
    }),
    vscode.commands.registerCommand(Commands.thesaurusSelectEngine, () => selectEngine()),
    vscode.languages.registerCompletionItemProvider(
      { language: MARKDOWN_LANGUAGE_ID },
      new ThesaurusCompletionProvider()
    ),
    vscode.workspace.onDidChangeTextDocument((e) => {
      // After an edit to that document (incl. accepting a suggestion) the list
      // is stale.
      if (pending && e.document.uri.toString() === pending.uri) {
        pending = undefined;
      }
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.thesaurusAiMode}`)) {
        syncAiModeContext();
      }
    })
  );
}

function getAiMode(): AiMode {
  return vscode.workspace
    .getConfiguration(EXTENSION_ID)
    .get<AiMode>(ConfigKeys.thesaurusAiMode, 'ask');
}

/** Whether to use AI for a lookup. On by default (no separate opt-in) unless the
 *  user pinned the dictionary ('local'). Single-model design: AI synonyms run on
 *  the one editor model, so this is gated on an AI engine being active. */
function shouldUseAi(): boolean {
  if (getAiMode() === 'local') {
    return false; // user chose dictionary-only via the engine picker
  }
  return currentModelName() !== 'off';
}

/** The model that answers AI lookups: the single editor model. */
function activeLookupModel(): string {
  return currentModelName();
}

async function setAiMode(mode: AiMode): Promise<void> {
  await vscode.workspace
    .getConfiguration(EXTENSION_ID)
    .update(ConfigKeys.thesaurusAiMode, mode, vscode.ConfigurationTarget.Global);
  syncAiModeContext();
}

function syncAiModeContext(): void {
  void vscode.commands.executeCommand('setContext', AI_MODE_CONTEXT_KEY, getAiMode());
}

/** One picker to choose where synonyms & antonyms come from — collapsing the two
 *  config knobs (aiMode + dictionary source) into a single clear choice. Marks
 *  the current selection and applies the right combination. */
async function selectEngine(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const mode = getAiMode();
  const source = cfg.get<Source>(ConfigKeys.thesaurusSource, 'auto');
  const model = activeLookupModel();
  // What's effectively active right now, for the check-mark.
  const activeId: EngineChoice =
    mode === 'ai' ? 'ai' : mode === 'ask' ? 'ask' : source;

  interface EngineItem extends vscode.QuickPickItem {
    id: EngineChoice;
  }
  const make = (id: EngineChoice, label: string, detail: string): EngineItem => ({
    id,
    label: (id === activeId ? '$(check) ' : '') + label,
    detail
  });
  // Single-model design: synonyms use the one AI model (Settings → AI Model),
  // the same model that powers Brainstorm/Revise/Spell.
  const aiDetail =
    model !== 'off'
      ? `Context-aware results from your AI model (${model}). Falls back to the dictionary if it isn’t running.`
      : 'Context-aware results from your local AI model (Ollama). Enable AI in Proser Settings first.';
  const items: EngineItem[] = [
    make('ai', '$(sparkle) AI model', aiDetail),
    make('online', '$(cloud) Online thesaurus (Datamuse)', 'Fast, broad word lists from the Datamuse API. Needs internet.'),
    make('offline', '$(book) Offline dictionary (WordNet)', 'Built-in, fully offline. Sparser, and weak on antonyms.'),
    make('auto', '$(list-unordered) Auto dictionary', 'Try Datamuse online, fall back to the offline dictionary.'),
    make('ask', '$(wand) Automatic (recommended)', 'Use the AI model whenever one is active, otherwise the dictionary.')
  ];

  const pick = await vscode.window.showQuickPick(items, {
    title: 'Synonym & Antonym Engine',
    placeHolder: 'Choose where suggestions come from'
  });
  if (!pick) {
    return;
  }
  if (pick.id === 'ai') {
    await enableAi(); // sets aiMode=ai and configures the AI Helper
  } else if (pick.id === 'ask') {
    await setAiMode('ask');
    vscode.window.setStatusBarMessage('$(question) Proser: will ask which engine on the next lookup.', 3000);
  } else {
    await setAiMode('local');
    await cfg.update(ConfigKeys.thesaurusSource, pick.id, vscode.ConfigurationTarget.Global);
    vscode.window.setStatusBarMessage(
      `$(book) Proser: synonyms now use the ${pick.id === 'online' ? 'online thesaurus' : pick.id === 'offline' ? 'offline dictionary' : 'auto dictionary'}.`,
      3000
    );
  }
}

/** Switches synonyms to the AI model — the single model that also powers
 *  Brainstorm/Revise/Spell. When no AI engine is set up yet, points the user at
 *  Settings → AI Model; until then synonyms fall back to the dictionary. */
async function enableAi(): Promise<void> {
  // Guard here (not just in the 'ask' prompt) so the command-palette and
  // right-click paths can't mutate global config in an untrusted workspace.
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(
      'Proser AI features are disabled in untrusted workspaces. Trust this workspace to enable them.'
    );
    return;
  }
  await setAiMode('ai');
  if (currentModelName() !== 'off') {
    vscode.window.setStatusBarMessage(
      `$(sparkle) Proser: synonyms now use ${currentModelName()}.`,
      4000
    );
  } else {
    const action = await vscode.window.showInformationMessage(
      'Synonyms will use your AI model. Enable AI and pick a model in Proser Settings → AI Model.',
      'Set up AI'
    );
    if (action === 'Set up AI') {
      void vscode.commands.executeCommand(Commands.aiSelectLocalModel);
    }
  }
}

/** Serves the pending synonym/antonym list as completions anchored at the word. */
class ThesaurusCompletionProvider implements vscode.CompletionItemProvider {
  provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): vscode.CompletionItem[] | undefined {
    if (!pending || pending.uri !== document.uri.toString()) {
      return undefined;
    }
    if (!pending.range.contains(position) && !pending.range.end.isEqual(position)) {
      return undefined;
    }
    const list = pending;
    return list.items.map((word, i) => {
      const item = new vscode.CompletionItem(word, vscode.CompletionItemKind.Text);
      item.range = list.range; // replace the whole original word
      item.insertText = word;
      item.filterText = list.word; // match regardless of the word already there
      item.sortText = String(i).padStart(4, '0');
      item.preselect = i === 0;
      item.detail = list.detail;
      return item;
    });
  }
}

async function runThesaurus(kind: ThesaurusKind): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== MARKDOWN_LANGUAGE_ID) {
    return;
  }
  const doc = editor.document;

  const range = editor.selection.isEmpty
    ? doc.getWordRangeAtPosition(editor.selection.active)
    : editor.selection;
  if (!range) {
    vscode.window.showInformationMessage('Place the cursor on a word first.');
    return;
  }

  const original = doc.getText(range).trim();
  const query = original.toLowerCase();
  if (!/[\p{L}]/u.test(query)) {
    vscode.window.showInformationMessage('Select a word to look up.');
    return;
  }

  const sentence = doc.lineAt(range.start.line).text.trim();
  const noun = kind === 'synonyms' ? 'synonyms' : 'antonyms';

  // Use the small synonyms helper automatically (never the big editor model);
  // dictionary otherwise.
  const lookup = await gatherWords(kind, query, sentence, shouldUseAi());
  const unique = lookup.words;
  if (unique.length === 0) {
    vscode.window.showInformationMessage(
      noResultsMessage(noun, original, kind, lookup.triedAi, lookup.aiStatus)
    );
    return;
  }

  // Re-check the word is still there AND the caret hasn't moved off it, so we
  // don't yank the cursor back after the async work.
  const active = vscode.window.activeTextEditor;
  if (!active || active !== editor || doc.getText(range).trim().toLowerCase() !== query) {
    return;
  }
  const caret = active.selection.active;
  if (!range.contains(caret) && !range.end.isEqual(caret)) {
    return;
  }
  const label = sourceLabel(lookup.source);
  pending = {
    uri: doc.uri.toString(),
    range,
    word: original,
    items: unique.map((w) => matchCapitalization(original, w)),
    detail: `Proser · ${label}`
  };
  editor.selection = new vscode.Selection(range.end, range.end);
  // A visible, transient confirmation of which source answered (AI vs dictionary).
  vscode.window.setStatusBarMessage(
    `$(${lookup.source === 'ai' ? 'sparkle' : 'book'}) Proser: ${unique.length} ${noun} · ${label}`,
    3500
  );
  await vscode.commands.executeCommand('editor.action.triggerSuggest');
}

/** Human label for where suggestions came from. */
function sourceLabel(source: LookupSource): string {
  switch (source) {
    case 'ai':
      return `AI (${activeLookupModel()})`;
    case 'online':
      return 'Datamuse';
    case 'offline':
      return 'offline dictionary';
    default:
      return 'dictionary';
  }
}

/** A no-results message that says what was tried, why the AI didn't help, and what to do. */
export function noResultsMessage(
  noun: string,
  original: string,
  kind: ThesaurusKind,
  triedAi: boolean,
  aiStatus: AiStatus
): string {
  let msg = `No ${noun} found for “${original}”.`;
  if (triedAi && (aiStatus === 'not-ready' || aiStatus === 'off')) {
    msg += ' The AI model isn’t running — click the model name in the status bar to start it.';
  } else if (triedAi && aiStatus === 'timeout') {
    msg += ' The AI model timed out — a smaller, faster model (e.g. gemma4:e4b) helps.';
  } else if (triedAi && aiStatus === 'error') {
    msg += ' The AI model errored, and the dictionary had nothing either.';
  } else if (triedAi) {
    msg += ' The AI model and dictionary both came up empty — try a more common word form.';
  } else {
    // No AI was used (no model is active).
    msg += ' Set up a local AI model (status bar → Model) for context-aware results.';
    if (kind === 'antonyms') {
      msg += ' Antonyms especially need a model — the dictionary rarely has them.';
    }
  }
  return msg;
}

/** Shared gather: AI-first (when enabled and ready) with a soft timeout, then
 *  the Datamuse/WordNet fallback; returns the deduped, capped list. */
async function gatherWords(
  kind: ThesaurusKind,
  query: string,
  sentence: string,
  useAi: boolean
): Promise<{ words: string[]; source: LookupSource; triedAi: boolean; aiStatus: AiStatus }> {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const source = cfg.get<Source>(ConfigKeys.thesaurusSource, 'auto');
  const max = cfg.get<number>(ConfigKeys.thesaurusMaxResults, 20);
  const noun = kind === 'synonyms' ? 'synonyms' : 'antonyms';
  let resultSource: LookupSource = 'none';
  let triedAi = false;
  let aiStatus: AiStatus = 'skipped';
  const controller = new AbortController();
  const words = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Proser: finding ${noun}…`, cancellable: true },
    async (_p, token) => {
      token.onCancellationRequested(() => controller.abort());
      if (useAi) {
        triedAi = true;
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const ai = await aiSuggestions(query, sentence, kind, max, controller.signal);
          aiStatus = ai.status;
          if (ai.words.length > 0) {
            resultSource = 'ai';
            return ai.words;
          }
        } finally {
          clearTimeout(timer);
        }
      }
      const dict = await gatherSuggestions(query, kind, source, max);
      resultSource = dict.source;
      return dict.words;
    }
  );
  const deduped = dedupe(words, query).slice(0, max);
  const finalSource: LookupSource = deduped.length ? resultSource : 'none';
  log(`${noun} "${query}" — aiMode=${getAiMode()} ai=${aiStatus} source=${finalSource} results=${deduped.length}`);
  return { words: deduped, source: finalSource, triedAi, aiStatus };
}

/** Returns the capitalization-matched suggestion list (no UI). The pretty view
 *  renders its own anchored card from this, so we don't show a QuickPick. */
export async function suggestionsFor(
  kind: ThesaurusKind,
  word: string,
  sentence: string
): Promise<{ words: string[]; sourceLabel: string; triedAi: boolean; aiStatus: AiStatus }> {
  const original = word.trim();
  const query = original.toLowerCase();
  if (!/[\p{L}]/u.test(query)) {
    return { words: [], sourceLabel: '', triedAi: false, aiStatus: 'skipped' };
  }
  const lookup = await gatherWords(kind, query, sentence, shouldUseAi());
  return {
    words: lookup.words.map((w) => matchCapitalization(original, w)),
    sourceLabel: sourceLabel(lookup.source),
    triedAi: lookup.triedAi,
    aiStatus: lookup.aiStatus
  };
}

async function gatherSuggestions(
  word: string,
  kind: ThesaurusKind,
  source: Source,
  max: number
): Promise<{ words: string[]; source: LookupSource }> {
  if (source === 'offline') {
    const w = await safe(() => fetchFromWordNet(word, kind, max));
    return { words: w, source: w.length ? 'offline' : 'none' };
  }
  if (source === 'online') {
    const w = await safe(() => fetchFromDatamuse(word, kind, max));
    return { words: w, source: w.length ? 'online' : 'none' };
  }
  // auto: prefer Datamuse, fall back to WordNet on error or empty result.
  try {
    const online = await fetchFromDatamuse(word, kind, max);
    if (online.length > 0) {
      return { words: online, source: 'online' };
    }
  } catch {
    // fall through to offline
  }
  const off = await safe(() => fetchFromWordNet(word, kind, max));
  return { words: off, source: off.length ? 'offline' : 'none' };
}

/** Best-effort AI suggestions; silent (never blocks the thesaurus) if the
 *  engine is off, unconfigured, or errors. */
async function aiSuggestions(
  word: string,
  sentence: string,
  kind: ThesaurusKind,
  max: number,
  signal?: AbortSignal
): Promise<{ words: string[]; status: AiStatus }> {
  try {
    // Always the small synonyms helper (its own server) — defaulting to the
    // recommended co-resident model when none is set. Never the big editor model,
    // so word lookups stay snappy and don't compete with Brainstorm/Revise.
    const engine = await getSynonymsEngine();
    if (!engine) {
      return { words: [], status: 'off' };
    }
    if (!(await engine.isReady()).ready) {
      return { words: [], status: 'not-ready' };
    }
    const words = await aiContextSuggestions(engine, word, sentence, kind, max, signal);
    return { words, status: words.length ? 'ok' : 'empty' };
  } catch {
    return { words: [], status: signal?.aborted ? 'timeout' : 'error' };
  }
}

async function safe(fn: () => Promise<string[]>): Promise<string[]> {
  try {
    return await fn();
  } catch {
    return [];
  }
}

function dedupe(words: string[], exclude: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (key === exclude || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** Mirrors the original word's capitalization onto the replacement. */
function matchCapitalization(original: string, replacement: string): string {
  const letters = original.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (/^\p{Lu}/u.test(original)) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  }
  return replacement;
}
