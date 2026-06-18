import * as vscode from 'vscode';
import { Commands, VIEW_TYPE_MARKDOWN_EDITOR, VIEW_TYPE_SPELLING } from '../../constants';
import { activeMarkdownDoc, columnForOpenUri } from '../manuscript/compile';
import { SpellService } from './spellService';
import { languageLabel } from './dictionaries';
import { getSpellingHtml } from './spellingHtml';

interface PanelItem {
  word: string;
  suggestions: string[];
  count: number;
}

/** Registers the dedicated "Spelling" sidebar view. */
export function registerSpellingView(context: vscode.ExtensionContext, spell: SpellService): void {
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      VIEW_TYPE_SPELLING,
      new SpellingViewProvider(context, spell),
      { webviewOptions: { retainContextWhenHidden: true } } // persist when hidden
    )
  );
}

/**
 * Lists the misspelled words in the active Markdown document (resolved from a
 * text editor OR the Pretty tab). Clicking a suggestion fixes every occurrence;
 * "Add to dictionary" clears the word everywhere. This replaces the Problems
 * panel as spelling's list surface.
 */
class SpellingViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly spell: SpellService
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = getSpellingHtml(view.webview, this.context.extensionUri);

    const disposables = [
      view.webview.onDidReceiveMessage((msg) => this.onMessage(msg)),
      this.spell.onDidChange(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.schedule()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const doc = activeMarkdownDoc();
        if (doc && e.document.uri.toString() === doc.uri.toString()) {
          this.schedule();
        }
      })
    ];
    view.onDidDispose(() => {
      if (this.timer) {
        clearTimeout(this.timer);
      }
      disposables.forEach((d) => d.dispose());
    });

    void this.refresh();
  }

  private onMessage(msg: { type: string; word?: string; suggestion?: string }): void {
    switch (msg.type) {
      case 'ready':
        void this.refresh();
        break;
      case 'addToDictionary':
        if (msg.word) {
          void this.spell.add(msg.word); // fires onDidChange → refresh
        }
        break;
      case 'ignore':
        if (msg.word) {
          void this.spell.ignore(msg.word); // suppress without adding to dictionary
        }
        break;
      case 'replace':
        if (msg.word && msg.suggestion) {
          void this.replaceAll(msg.word, msg.suggestion);
        }
        break;
      case 'reveal':
        if (msg.word) {
          void this.reveal(msg.word);
        }
        break;
      case 'selectLanguage':
        void vscode.commands.executeCommand(Commands.spellSelectLanguage);
        break;
    }
  }

  private schedule(): void {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => void this.refresh(), 300);
  }

  private async refresh(): Promise<void> {
    if (!this.view) {
      return;
    }
    const enabled = this.spell.enabled();
    const language = languageLabel(this.spell.currentLanguage);
    const doc = activeMarkdownDoc();
    if (!doc) {
      void this.view.webview.postMessage({ type: 'state', enabled, language, items: [], docName: '' });
      return;
    }
    const text = doc.getText();
    const found = enabled ? await this.spell.misspellings(text) : [];
    const items: PanelItem[] = found.map((m) => ({
      word: m.word,
      suggestions: m.suggestions,
      count: countWord(text, m.word)
    }));
    void this.view.webview.postMessage({
      type: 'state',
      enabled,
      language,
      items,
      docName: doc.uri.path.split('/').pop() ?? ''
    });
  }

  /** Replaces every whole-word occurrence of `word` with `suggestion`. */
  private async replaceAll(word: string, suggestion: string): Promise<void> {
    const doc = activeMarkdownDoc();
    if (!doc) {
      return;
    }
    const text = doc.getText();
    const re = wordRegex(word);
    const edit = new vscode.WorkspaceEdit();
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const range = new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length));
      edit.replace(doc.uri, range, suggestion);
    }
    await vscode.workspace.applyEdit(edit); // doc change → refresh via listener
  }

  /** Shows the word in the Pretty view (scrolls to + flashes the first
   *  occurrence). Falls back to selecting it in a text editor. */
  private async reveal(word: string): Promise<void> {
    const doc = activeMarkdownDoc();
    if (!doc) {
      return;
    }
    const column = columnForOpenUri(doc.uri) ?? vscode.ViewColumn.Beside;
    await vscode.commands.executeCommand('vscode.openWith', doc.uri, VIEW_TYPE_MARKDOWN_EDITOR, column);
    const revealed = await vscode.commands.executeCommand(
      Commands.revealInPretty,
      doc.uri.toString(),
      word
    );
    if (revealed) {
      return;
    }
    const m = wordRegex(word).exec(doc.getText());
    if (!m) {
      return;
    }
    const range = new vscode.Range(doc.positionAt(m.index), doc.positionAt(m.index + m[0].length));
    const editor = await vscode.window.showTextDocument(doc, { selection: range, viewColumn: column });
    editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
  }
}

/** Count of whole-word, case-sensitive occurrences of `word` in `text`. */
function countWord(text: string, word: string): number {
  const re = wordRegex(word);
  let n = 0;
  while (re.exec(text)) {
    n++;
  }
  return n;
}

/** Whole-word (letter/apostrophe/hyphen boundaries), case-sensitive matcher for
 *  the exact token the engine flagged. */
function wordRegex(word: string): RegExp {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}'’-])${esc}(?![\\p{L}'’-])`, 'gu');
}
