import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID, MARKDOWN_LANGUAGE_ID } from '../../constants';
import { fetchFromDatamuse, ThesaurusKind } from './datamuseClient';
import { fetchFromWordNet } from './offlineThesaurus';
import { SecretStore } from '../ai/secretStore';
import { createEngine, prepareEngine } from '../ai/engineFactory';
import { aiContextSuggestions } from '../ai/aiSynonyms';

type Source = 'online' | 'offline' | 'auto';
type AiMode = 'ask' | 'ai' | 'local';

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
  const secrets = new SecretStore(context.secrets);

  // Keep a context key in sync with the mode so the right-click menu can show
  // "Use AI…" vs "Use Local Dictionary…".
  syncAiModeContext();

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.synonyms, () => runThesaurus('synonyms', secrets)),
    vscode.commands.registerCommand(Commands.antonyms, () => runThesaurus('antonyms', secrets)),
    vscode.commands.registerCommand(Commands.useAiSynonyms, () => enableAi(secrets)),
    vscode.commands.registerCommand(Commands.useLocalSynonyms, async () => {
      await setAiMode('local');
      vscode.window.setStatusBarMessage(
        '$(book) Proser: synonyms now use the local dictionary.',
        3000
      );
    }),
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

async function setAiMode(mode: AiMode): Promise<void> {
  await vscode.workspace
    .getConfiguration(EXTENSION_ID)
    .update(ConfigKeys.thesaurusAiMode, mode, vscode.ConfigurationTarget.Global);
  syncAiModeContext();
}

function syncAiModeContext(): void {
  void vscode.commands.executeCommand('setContext', AI_MODE_CONTEXT_KEY, getAiMode());
}

/** Switches synonyms to AI: defaults the engine to local Ollama (Gemma) when
 *  none is configured, then walks through start/pull/key setup. */
async function enableAi(secrets: SecretStore): Promise<void> {
  // Guard here (not just in the 'ask' prompt) so the command-palette and
  // right-click paths can't mutate global config in an untrusted workspace.
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(
      'Proser AI features are disabled in untrusted workspaces. Trust this workspace to enable them.'
    );
    return;
  }
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const prevEngine = cfg.get<string>(ConfigKeys.aiEngine, 'off');
  if (prevEngine === 'off') {
    await cfg.update(ConfigKeys.aiEngine, 'ollama', vscode.ConfigurationTarget.Global);
  }
  await setAiMode('ai');

  const engine = await prepareEngine(secrets); // start / pull / key as needed
  if (engine) {
    vscode.window.setStatusBarMessage(`$(sparkle) Proser: synonyms now use ${engine.label}.`, 4000);
  } else {
    // Setup was cancelled/failed — don't leave a dangling global engine change
    // that would hijack Revise-with-AI (e.g. block the OpenRouter choice).
    if (prevEngine === 'off') {
      await cfg.update(ConfigKeys.aiEngine, 'off', vscode.ConfigurationTarget.Global);
    }
    vscode.window.setStatusBarMessage(
      '$(book) Proser: AI selected — using the dictionary until a model is ready.',
      4000
    );
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

async function runThesaurus(kind: ThesaurusKind, secrets: SecretStore): Promise<void> {
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

  // Decide whether to use AI for this lookup, prompting once if undecided.
  let useAi = getAiMode() === 'ai';
  if (getAiMode() === 'ask' && vscode.workspace.isTrusted) {
    const choice = await vscode.window.showInformationMessage(
      'Use a local AI model (Gemma) for richer, context-aware synonyms and antonyms? ' +
        'You can switch anytime from the editor right-click menu.',
      'Use AI',
      'Local dictionary only'
    );
    if (choice === 'Use AI') {
      await enableAi(secrets);
      useAi = true;
    } else if (choice === 'Local dictionary only') {
      await setAiMode('local');
    }
    // Dismissed: use the dictionary this once and ask again next time.
  }

  const { words: unique, usedAi } = await gatherWords(secrets, kind, query, sentence, useAi);
  if (unique.length === 0) {
    vscode.window.showInformationMessage(`No ${noun} found for “${original}”.`);
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
  pending = {
    uri: doc.uri.toString(),
    range,
    word: original,
    items: unique.map((w) => matchCapitalization(original, w)),
    detail: usedAi ? 'Proser · AI' : 'Proser'
  };
  editor.selection = new vscode.Selection(range.end, range.end);
  await vscode.commands.executeCommand('editor.action.triggerSuggest');
}

/** Shared gather: AI-first (when enabled and ready) with a soft timeout, then
 *  the Datamuse/WordNet fallback; returns the deduped, capped list. */
async function gatherWords(
  secrets: SecretStore,
  kind: ThesaurusKind,
  query: string,
  sentence: string,
  useAi: boolean
): Promise<{ words: string[]; usedAi: boolean }> {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const source = cfg.get<Source>(ConfigKeys.thesaurusSource, 'auto');
  const max = cfg.get<number>(ConfigKeys.thesaurusMaxResults, 20);
  const noun = kind === 'synonyms' ? 'synonyms' : 'antonyms';
  let usedAi = false;
  const controller = new AbortController();
  const words = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Window, title: `Proser: finding ${noun}…`, cancellable: true },
    async (_p, token) => {
      token.onCancellationRequested(() => controller.abort());
      if (useAi) {
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
          const ai = await aiSuggestions(secrets, query, sentence, kind, max, controller.signal);
          if (ai.length > 0) {
            usedAi = true;
            return ai;
          }
        } finally {
          clearTimeout(timer);
        }
      }
      return gatherSuggestions(query, kind, source, max);
    }
  );
  return { words: dedupe(words, query).slice(0, max), usedAi };
}

/** Returns the capitalization-matched suggestion list (no UI). The pretty view
 *  renders its own anchored card from this, so we don't show a QuickPick. */
export async function suggestionsFor(
  secrets: SecretStore,
  kind: ThesaurusKind,
  word: string,
  sentence: string
): Promise<string[]> {
  const original = word.trim();
  const query = original.toLowerCase();
  if (!/[\p{L}]/u.test(query)) {
    return [];
  }
  const { words } = await gatherWords(secrets, kind, query, sentence, getAiMode() === 'ai');
  return words.map((w) => matchCapitalization(original, w));
}

async function gatherSuggestions(
  word: string,
  kind: ThesaurusKind,
  source: Source,
  max: number
): Promise<string[]> {
  if (source === 'offline') {
    return safe(() => fetchFromWordNet(word, kind, max));
  }
  if (source === 'online') {
    return safe(() => fetchFromDatamuse(word, kind, max));
  }
  // auto: prefer Datamuse, fall back to WordNet on error or empty result.
  try {
    const online = await fetchFromDatamuse(word, kind, max);
    if (online.length > 0) {
      return online;
    }
  } catch {
    // fall through to offline
  }
  return safe(() => fetchFromWordNet(word, kind, max));
}

/** Best-effort AI suggestions; silent (never blocks the thesaurus) if the
 *  engine is off, unconfigured, or errors. */
async function aiSuggestions(
  secrets: SecretStore,
  word: string,
  sentence: string,
  kind: ThesaurusKind,
  max: number,
  signal?: AbortSignal
): Promise<string[]> {
  try {
    const engine = await createEngine(secrets);
    if (!engine || !(await engine.isReady()).ready) {
      return [];
    }
    return await aiContextSuggestions(engine, word, sentence, kind, max, signal);
  } catch {
    return [];
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
