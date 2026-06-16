import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID, MARKDOWN_LANGUAGE_ID } from '../../constants';
import { createKeyedDebouncer } from '../../util/debounce';
import { getProseTokens } from '../../util/wordcount';
import { ScanOptions } from '../../util/markdownScan';
import { UserDictionary } from './userDictionary';
import { SpellEngine } from './spellEngine';
import { SpellCodeActions, SPELL_CODE, SPELL_SOURCE } from './spellCodeActions';

const MAX_DIAGNOSTICS = 1000;
const MAX_DOC_SIZE = 500_000; // characters; skip spell check on very large files

export function registerSpellCheck(context: vscode.ExtensionContext): void {
  const collection = vscode.languages.createDiagnosticCollection('proser-spell');
  context.subscriptions.push(collection);

  const userDict = new UserDictionary(context);
  const engine = new SpellEngine(userDict);

  // Read the delay at schedule time so a config change takes effect live.
  const debouncer = createKeyedDebouncer(() =>
    vscode.workspace
      .getConfiguration(EXTENSION_ID)
      .get<number>(ConfigKeys.spellcheckDebounceMs, 1000)
  );
  context.subscriptions.push({ dispose: () => debouncer.dispose() });

  function enabled(): boolean {
    return vscode.workspace
      .getConfiguration(EXTENSION_ID)
      .get<boolean>(ConfigKeys.spellcheckEnabled, true);
  }

  function isTarget(doc: vscode.TextDocument): boolean {
    return doc.languageId === MARKDOWN_LANGUAGE_ID && doc.uri.scheme === 'file';
  }

  async function check(doc: vscode.TextDocument): Promise<void> {
    if (!isTarget(doc) || !enabled()) {
      collection.delete(doc.uri);
      return;
    }
    const text = doc.getText();
    if (text.length > MAX_DOC_SIZE) {
      collection.delete(doc.uri);
      return;
    }
    if (!(await engine.ready())) {
      return;
    }
    // Code is intentionally counted (spell check applies to prose words only).
    const opts: ScanOptions = {};
    const diagnostics: vscode.Diagnostic[] = [];
    for (const token of getProseTokens(text, opts)) {
      if (engine.isCorrect(token.word)) {
        continue;
      }
      const range = new vscode.Range(doc.positionAt(token.start), doc.positionAt(token.end));
      const diag = new vscode.Diagnostic(
        range,
        `“${token.word}” may be misspelled.`,
        vscode.DiagnosticSeverity.Information
      );
      diag.source = SPELL_SOURCE;
      diag.code = SPELL_CODE;
      diagnostics.push(diag);
      if (diagnostics.length >= MAX_DIAGNOSTICS) {
        break;
      }
    }
    collection.set(doc.uri, diagnostics);
  }

  function recheckAllOpen(): void {
    for (const doc of vscode.workspace.textDocuments) {
      void check(doc);
    }
  }

  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider(
      { language: MARKDOWN_LANGUAGE_ID, scheme: 'file' },
      new SpellCodeActions(engine),
      SpellCodeActions.metadata
    ),
    vscode.commands.registerCommand(Commands.addToDictionary, async (word?: string) => {
      if (!word) {
        return;
      }
      await userDict.add(word);
      engine.add(word);
      recheckAllOpen();
    }),
    vscode.workspace.onDidOpenTextDocument((doc) => void check(doc)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (isTarget(e.document)) {
        debouncer.schedule(e.document.uri.toString(), () => void check(e.document));
      }
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => collection.delete(doc.uri)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${EXTENSION_ID}.spellcheck`)) {
        if (!enabled()) {
          collection.clear();
        } else {
          recheckAllOpen();
        }
      }
    })
  );

  recheckAllOpen();
}
