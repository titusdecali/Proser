import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID, VIEW_TYPE_MARKDOWN_EDITOR } from '../../constants';
import { getEditorHtml } from './webviewHtml';
import { computeProseStats, estimateReadingMinutes } from '../../util/wordcount';
import { wordcountScanOptions } from '../../util/scanConfig';
import { SecretStore } from '../ai/secretStore';
import { suggestionsFor } from '../thesaurus/thesaurusCommands';
import { ThesaurusKind } from '../thesaurus/datamuseClient';
import { reviseOptions } from '../ai/reviseCommand';
import { readPrompts, writePrompts, SavedPrompt } from '../ai/prompts';

/** Registers the custom editor and the "Open Pretty Editable View" commands. */
export function registerPrettyEditor(context: vscode.ExtensionContext): void {
  function resolveTarget(uri?: vscode.Uri): vscode.Uri | undefined {
    const target = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!target) {
      vscode.window.showInformationMessage('Open a Markdown file to use the pretty editor.');
      return undefined;
    }
    if (!target.path.toLowerCase().endsWith('.md')) {
      vscode.window.showInformationMessage('The pretty editor is for Markdown (.md) files.');
      return undefined;
    }
    return target;
  }

  context.subscriptions.push(
    ProserEditorProvider.register(context),
    // Replace the current tab with the pretty editor (like "Reopen With").
    vscode.commands.registerCommand(Commands.openPretty, async (uri?: vscode.Uri) => {
      const target = resolveTarget(uri);
      if (target) {
        await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE_MARKDOWN_EDITOR);
      }
    }),
    // Open the pretty editor BESIDE the raw editor so both stay live and no
    // save prompt is triggered — the native-preview feel, but editable.
    vscode.commands.registerCommand(Commands.openPrettyToSide, async (uri?: vscode.Uri) => {
      const target = resolveTarget(uri);
      if (target) {
        await vscode.commands.executeCommand(
          'vscode.openWith',
          target,
          VIEW_TYPE_MARKDOWN_EDITOR,
          vscode.ViewColumn.Beside
        );
      }
    })
  );
}

interface FromWebview {
  type:
    | 'ready'
    | 'edit'
    | 'editRaw'
    | 'setFontSize'
    | 'exportPdf'
    | 'exportError'
    | 'thesaurusRequest'
    | 'reviseRequest'
    | 'promptsLoad'
    | 'promptsSave';
  text?: string;
  size?: number;
  data?: string;
  filename?: string;
  message?: string;
  kind?: ThesaurusKind;
  word?: string;
  sentence?: string;
  instruction?: string;
  prompts?: SavedPrompt[];
}

/**
 * Editable pretty viewer. A CustomTextEditorProvider backs a Toast UI WYSIWYG
 * editor with the real TextDocument, so edits are genuine document edits.
 *
 * Echo loops are prevented with a content guard rather than a timing flag:
 * `lastSynced` holds the text currently reflected in the webview. A document
 * change equal to `lastSynced` is our own write and is ignored; anything else
 * is an external edit and is pushed to the webview.
 */
export class ProserEditorProvider implements vscode.CustomTextEditorProvider {
  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE_MARKDOWN_EDITOR,
      new ProserEditorProvider(context),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): void {
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    panel.webview.html = getEditorHtml(panel.webview, this.context.extensionUri);

    const secrets = new SecretStore(this.context.secrets);
    let lastSynced = document.getText();
    const syncDebounceMs = vscode.workspace
      .getConfiguration(EXTENSION_ID)
      .get<number>(ConfigKeys.wysiwygSyncDebounceMs, 200);
    let syncTimer: NodeJS.Timeout | undefined;

    const pushToWebview = (text: string) => {
      void panel.webview.postMessage({ type: 'update', text });
    };

    let statsTimer: NodeJS.Timeout | undefined;
    const postStats = () => {
      const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
      const stats = computeProseStats(document.getText(), wordcountScanOptions());
      const wpm = cfg.get<number>(ConfigKeys.wordcountWordsPerMinute, 200);
      void panel.webview.postMessage({
        type: 'stats',
        stats: {
          ...stats,
          lines: document.lineCount,
          minutes: estimateReadingMinutes(stats.words, wpm)
        }
      });
    };
    const scheduleStats = () => {
      if (statsTimer) {
        clearTimeout(statsTimer);
      }
      statsTimer = setTimeout(postStats, 400);
    };

    const postConfig = () => {
      const wsCfg = vscode.workspace.getConfiguration(EXTENSION_ID);
      const fontSize = wsCfg.get<number>(ConfigKeys.wysiwygFontSize, 16);
      const maxWidth = wsCfg.get<string>(ConfigKeys.wysiwygMaxWidth, '65ch');
      const base = document.uri.path.split('/').pop() ?? 'document.md';
      void panel.webview.postMessage({
        type: 'config',
        fontSize,
        maxWidth,
        filename: base.replace(/\.md$/i, '') + '.pdf'
      });
    };

    const savePdf = async (base64: string, filename: string) => {
      try {
        const bytes = Buffer.from(base64, 'base64');
        const defaultUri = vscode.Uri.joinPath(document.uri, '..', filename);
        const target = await vscode.window.showSaveDialog({
          defaultUri,
          filters: { PDF: ['pdf'] }
        });
        if (!target) {
          return;
        }
        await vscode.workspace.fs.writeFile(target, bytes);
        const choice = await vscode.window.showInformationMessage(`Saved ${filename}`, 'Open');
        if (choice === 'Open') {
          void vscode.env.openExternal(target);
        }
      } catch (err) {
        vscode.window.showErrorMessage(
          `Could not save PDF: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    const applyFromWebview = async (text: string) => {
      // The webview is now the source of truth — cancel any pending external
      // push that would otherwise revert this edit.
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = undefined;
      }
      if (text === document.getText()) {
        lastSynced = text;
        return;
      }
      lastSynced = text;
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );
      edit.replace(document.uri, fullRange, text);
      await vscode.workspace.applyEdit(edit);
    };

    const messageSub = panel.webview.onDidReceiveMessage(async (msg: FromWebview) => {
      switch (msg.type) {
        case 'ready':
          lastSynced = document.getText();
          postConfig();
          pushToWebview(lastSynced);
          postStats();
          break;
        case 'edit':
          if (typeof msg.text === 'string') {
            void applyFromWebview(msg.text);
          }
          break;
        case 'editRaw':
          void vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
          break;
        case 'setFontSize':
          if (typeof msg.size === 'number') {
            await vscode.workspace
              .getConfiguration(EXTENSION_ID)
              .update(ConfigKeys.wysiwygFontSize, msg.size, vscode.ConfigurationTarget.Global);
          }
          break;
        case 'exportPdf':
          if (msg.data) {
            await savePdf(msg.data, msg.filename ?? 'document.pdf');
          }
          break;
        case 'exportError':
          vscode.window.showErrorMessage(`PDF export failed: ${msg.message ?? 'unknown error'}`);
          break;
        case 'thesaurusRequest':
          if (msg.kind && msg.word) {
            const words = await suggestionsFor(secrets, msg.kind, msg.word, msg.sentence ?? '');
            if (words.length === 0) {
              vscode.window.showInformationMessage(`No ${msg.kind} found for “${msg.word}”.`);
            } else {
              void panel.webview.postMessage({ type: 'thesaurusResult', words, word: msg.word });
            }
          }
          break;
        case 'reviseRequest':
          if (typeof msg.text === 'string' && msg.text.trim().length > 0) {
            const options = await reviseOptions(secrets, msg.text, msg.instruction, 3);
            if (options.length > 0) {
              void panel.webview.postMessage({ type: 'reviseResult', options });
            }
          }
          break;
        case 'promptsLoad': {
          const prompts = await readPrompts(document.uri);
          void panel.webview.postMessage({ type: 'promptsResult', prompts });
          break;
        }
        case 'promptsSave': {
          await writePrompts(msg.prompts ?? [], document.uri);
          const prompts = await readPrompts(document.uri);
          void panel.webview.postMessage({ type: 'promptsResult', prompts });
          break;
        }
      }
    });

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) {
        return;
      }
      scheduleStats(); // footer reflects every change, incl. our own writes
      const text = document.getText();
      if (text === lastSynced) {
        return; // our own write — don't echo
      }
      lastSynced = text;
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      syncTimer = setTimeout(() => {
        // Only push if no newer edit (e.g. from the webview) superseded this one.
        if (text === lastSynced) {
          pushToWebview(text);
        }
      }, syncDebounceMs);
    });

    const configSub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.wysiwygMaxWidth}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.wysiwygFontSize}`)
      ) {
        postConfig();
      }
    });

    panel.onDidDispose(() => {
      messageSub.dispose();
      changeSub.dispose();
      configSub.dispose();
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      if (statsTimer) {
        clearTimeout(statsTimer);
      }
    });
  }
}
