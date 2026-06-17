import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID, VIEW_TYPE_MARKDOWN_EDITOR } from '../../constants';
import { getEditorHtml } from './webviewHtml';
import { computeProseStats, estimateReadingMinutes } from '../../util/wordcount';
import { wordcountScanOptions } from '../../util/scanConfig';
import { SecretStore } from '../ai/secretStore';
import { suggestionsFor, noResultsMessage } from '../thesaurus/thesaurusCommands';
import { ThesaurusKind } from '../thesaurus/datamuseClient';
import { reviseOptions } from '../ai/reviseCommand';
import { readPrompts, writePrompts, SavedPrompt } from '../ai/prompts';
import { currentModelName } from '../ai/aiModelStatus';
import { SpellService } from '../spellcheck/spellService';

/** Open Pretty editors keyed by document URI, so the sidebar's "Go" can reveal a
 *  passage in the right Pretty webview instead of the raw Markdown editor. */
const prettyPanels = new Map<string, vscode.WebviewPanel>();

/** Registers the custom editor and the "Open Pretty Editable View" commands. */
export function registerPrettyEditor(context: vscode.ExtensionContext, spell: SpellService): void {
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
    ProserEditorProvider.register(context, spell),
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
    }),
    // Reveal a passage inside the open Pretty editor for `uriStr` (used by the
    // sidebar's "Go" so it lands in the Pretty view, not the raw editor).
    vscode.commands.registerCommand(Commands.revealInPretty, (uriStr: string, text: string) => {
      const panel = prettyPanels.get(uriStr);
      if (!panel) {
        return false;
      }
      try {
        panel.reveal(panel.viewColumn);
      } catch {
        /* ignore */
      }
      void panel.webview.postMessage({ type: 'reveal', text });
      return true;
    }),
    // Insert at the Pretty editor's cursor (sidebar Insert tab). `kind` is 'hr'
    // for a horizontal rule, else the literal text is inserted.
    vscode.commands.registerCommand(
      Commands.insertInPretty,
      (uriStr: string, kind: string, text: string) => {
        const panel = prettyPanels.get(uriStr);
        if (!panel) {
          return false;
        }
        try {
          panel.reveal(panel.viewColumn);
        } catch {
          /* ignore */
        }
        void panel.webview.postMessage(
          kind === 'hr' ? { type: 'insertHr' } : { type: 'insertText', text }
        );
        return true;
      }
    )
  );
}

interface FromWebview {
  type:
    | 'ready'
    | 'edit'
    | 'editRaw'
    | 'setFontSize'
    | 'toggleSpellcheck'
    | 'addToDictionary'
    | 'selectModel'
    | 'showIssues'
    | 'exportMenu'
    | 'exportPdf'
    | 'exportError'
    | 'thesaurusRequest'
    | 'reviseRequest'
    | 'promptsLoad'
    | 'promptsSave';
  text?: string;
  size?: number;
  enabled?: boolean;
  data?: string;
  filename?: string;
  message?: string;
  kind?: ThesaurusKind;
  word?: string;
  sentence?: string;
  instruction?: string;
  prompts?: SavedPrompt[];
}

/** The toolbar "Export" menu: Standard-Manuscript-Format DOCX/PDF for the active
 *  file or the whole folder, plus a quick PDF of the current styled view (which
 *  runs in the webview via html2pdf). */
async function showExportMenu(panel: vscode.WebviewPanel): Promise<void> {
  type Opt = vscode.QuickPickItem & { run: () => Thenable<unknown> };
  const opts: Opt[] = [
    {
      label: '$(file-pdf) PDF — Standard Manuscript Format',
      description: 'This file',
      run: () => vscode.commands.executeCommand(Commands.manuscriptExportPdf, 'active')
    },
    {
      label: '$(file-pdf) PDF — Standard Manuscript Format',
      description: 'All pages in folder',
      run: () => vscode.commands.executeCommand(Commands.manuscriptExportPdf, 'folder')
    },
    {
      label: '$(file) DOCX — Standard Manuscript Format',
      description: 'This file',
      run: () => vscode.commands.executeCommand(Commands.manuscriptExportDocx, 'active')
    },
    {
      label: '$(file) DOCX — Standard Manuscript Format',
      description: 'All pages in folder',
      run: () => vscode.commands.executeCommand(Commands.manuscriptExportDocx, 'folder')
    },
    {
      label: '$(device-camera) PDF — Quick (current styled view)',
      description: 'What you see in Pretty',
      run: () => panel.webview.postMessage({ type: 'doQuickPdf' })
    }
  ];
  const picked = await vscode.window.showQuickPick(opts, {
    title: 'Export',
    placeHolder: 'Choose a format and scope'
  });
  if (picked) {
    await picked.run();
  }
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
  static register(context: vscode.ExtensionContext, spell: SpellService): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      VIEW_TYPE_MARKDOWN_EDITOR,
      new ProserEditorProvider(context, spell),
      {
        webviewOptions: { retainContextWhenHidden: true },
        supportsMultipleEditorsPerDocument: false
      }
    );
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly spell: SpellService
  ) {}

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

    const docKey = document.uri.toString();
    prettyPanels.set(docKey, panel); // so the sidebar's "Go" can reveal here

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

    // Misspelled words for the current text → the webview paints inline squiggles.
    // Empty list when spell check is off (which also clears the squiggles).
    let spellTimer: NodeJS.Timeout | undefined;
    const postSpell = async () => {
      const words = this.spell.enabled() ? await this.spell.misspellings(document.getText()) : [];
      void panel.webview.postMessage({ type: 'spellResult', words });
    };
    const scheduleSpell = () => {
      if (spellTimer) {
        clearTimeout(spellTimer);
      }
      spellTimer = setTimeout(() => void postSpell(), 400);
    };
    // Re-push spelling when the dictionary or the enabled toggle changes.
    const spellSub = this.spell.onDidChange(() => void postSpell());

    const postConfig = () => {
      const wsCfg = vscode.workspace.getConfiguration(EXTENSION_ID);
      const fontSize = wsCfg.get<number>(ConfigKeys.wysiwygFontSize, 18);
      const maxWidth = wsCfg.get<string>(ConfigKeys.wysiwygMaxWidth, '80ch');
      const spellcheckEnabled = wsCfg.get<boolean>(ConfigKeys.spellcheckEnabled, true);
      const base = document.uri.path.split('/').pop() ?? 'document.md';
      void panel.webview.postMessage({
        type: 'config',
        fontSize,
        maxWidth,
        spellcheckEnabled,
        model: currentModelName(),
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
          void postSpell();
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
        case 'toggleSpellcheck':
          if (typeof msg.enabled === 'boolean') {
            await vscode.workspace
              .getConfiguration(EXTENSION_ID)
              .update(ConfigKeys.spellcheckEnabled, msg.enabled, vscode.ConfigurationTarget.Global);
          }
          break;
        case 'addToDictionary':
          if (msg.word) {
            await this.spell.add(msg.word); // fires onDidChange → re-posts spellResult
          }
          break;
        case 'selectModel':
          // Same picker as the status bar — switch model / manage pulled models.
          await vscode.commands.executeCommand(Commands.aiSelectLocalModel);
          break;
        case 'showIssues':
          // Open the Proser sidebar on the Editor (tense/passive/continuity) tab.
          await vscode.commands.executeCommand(Commands.editorChecks);
          break;
        case 'exportMenu':
          await showExportMenu(panel);
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
            const res = await suggestionsFor(secrets, msg.kind, msg.word, msg.sentence ?? '');
            if (res.words.length === 0) {
              vscode.window.showInformationMessage(
                noResultsMessage(msg.kind, msg.word, msg.kind, res.triedAi, res.aiStatus)
              );
            } else {
              void panel.webview.postMessage({
                type: 'thesaurusResult',
                words: res.words,
                word: msg.word,
                source: res.sourceLabel
              });
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
      scheduleSpell(); // re-check spelling on every change (incl. webview edits)
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
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.wysiwygFontSize}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.spellcheck`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.ai`)
      ) {
        postConfig();
      }
    });

    panel.onDidDispose(() => {
      if (prettyPanels.get(docKey) === panel) {
        prettyPanels.delete(docKey);
      }
      messageSub.dispose();
      changeSub.dispose();
      configSub.dispose();
      spellSub.dispose();
      if (syncTimer) {
        clearTimeout(syncTimer);
      }
      if (statsTimer) {
        clearTimeout(statsTimer);
      }
      if (spellTimer) {
        clearTimeout(spellTimer);
      }
    });
  }
}
