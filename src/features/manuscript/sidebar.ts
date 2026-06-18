/** The Proser "Manuscript" sidebar (Activity Bar) — a tabbed webview:
 *  • Editor   — tense / passive-voice / continuity checks (scan once or continuously)
 *  • Insert   — chapter / scene break / part divider / THE END
 *  • Settings — title & author, DOCX/PDF export
 *  Insert/Settings buttons fire allow-listed manuscript commands; the Editor tab
 *  drives the AI checks (see ../issues/scanner). */
import * as vscode from 'vscode';
import {
  Commands,
  STATE_ISSUES_AUTOSCAN,
  STATE_ISSUES_IGNORED,
  VIEW_TYPE_MARKDOWN_EDITOR
} from '../../constants';
import { getNonce } from '../../util/nonce';
import { sizeSidePanel } from '../../util/editorLayout';
import { PROSER_THEME_VARS } from '../../util/webviewTheme';
import { SecretStore } from '../ai/secretStore';
import { SpellService } from '../spellcheck/spellService';
import { languageLabel } from '../spellcheck/dictionaries';
import { activeMarkdownDoc, columnForOpenUri } from './compile';
import {
  CheckKind,
  Issue,
  ScanScope,
  Tense,
  applyFix,
  relocate,
  rewriteIssue,
  runCheck
} from '../issues/scanner';

export const MANUSCRIPT_VIEW_ID = 'proser.manuscriptView';

const COMMAND_BUTTONS = new Set<string>([
  Commands.manuscriptTitlePage,
  Commands.manuscriptNewChapter,
  Commands.manuscriptSceneBreak,
  Commands.manuscriptDivider,
  Commands.manuscriptExportDocx,
  Commands.manuscriptExportPdf,
  Commands.thesaurusSelectEngine
]);

type TargetTense = Tense | 'auto';
const RESCAN_DEBOUNCE_MS = 6000;

export class ManuscriptSidebar implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private readonly secrets: SecretStore;
  private readonly issuesByKind = new Map<CheckKind, Issue[]>();
  private readonly ran = new Set<CheckKind>();
  private readonly ignored: Set<string>;
  private scanning = false;
  private continuous: boolean;
  private scope: ScanScope = 'active';
  private tense: TargetTense = 'auto';
  private detectedTense: string | null = null;
  private engineOff = false;
  private changeTimer?: ReturnType<typeof setTimeout>;
  private spellTimer?: ReturnType<typeof setTimeout>;
  private pendingTab?: string;
  private panel?: vscode.WebviewPanel;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly spell: SpellService
  ) {
    this.secrets = new SecretStore(context.secrets);
    this.continuous = context.workspaceState.get<boolean>(STATE_ISSUES_AUTOSCAN, false);
    this.ignored = new Set(context.workspaceState.get<string[]>(STATE_ISSUES_IGNORED, []));
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e)),
      // Keep the editor-tab panel's Spelling section live (no-ops while that panel
      // is closed; the activity-bar sidebar uses the standalone Spelling view).
      this.spell.onDidChange(() => this.scheduleSpell()),
      vscode.window.onDidChangeActiveTextEditor(() => this.scheduleSpell()),
      vscode.window.tabGroups.onDidChangeTabs(() => this.scheduleSpell()),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.scheduleSpell()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const doc = activeMarkdownDoc();
        if (doc && e.document.uri.toString() === doc.uri.toString()) {
          this.scheduleSpell();
        }
      })
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((msg) => this.onMessage(msg));
  }

  /** Opens the Proser panel (Editor checks / Insert / Settings) as a MOVABLE
   *  editor tab — like the Brainstorm chat — so it can be split or placed
   *  anywhere instead of fighting the side bar. Reuses the sidebar's HTML +
   *  message logic; state is shared so the tab and side bar stay in sync. The
   *  Pretty toolbar "Editor" button and the "p" title-bar icon both call this. */
  /** The Editor button: toggles the Proser checks tab (Editor/Insert/Settings)
   *  as a movable editor tab beside the active file — open on first click, close
   *  on the next. Brainstorm is opened separately via its own toolbar button. */
  async toggleWorkspace(): Promise<void> {
    if (this.panel) {
      this.panel.dispose();
      return;
    }
    this.showPanel(vscode.ViewColumn.Beside);
  }

  /** Opens or reveals the Proser checks panel in `column` (no toggle). */
  private showPanel(column: vscode.ViewColumn): vscode.WebviewPanel {
    if (this.panel) {
      this.panel.reveal(column);
      void this.panel.webview.postMessage({ type: 'showTab', tab: 'editor' });
      return this.panel;
    }
    const panel = vscode.window.createWebviewPanel('proser.manuscriptPanel', 'Proser', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    });
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'proser.svg');
    panel.webview.html = this.html(panel.webview, true); // include the Spelling section
    panel.webview.onDidReceiveMessage((msg) => {
      this.onMessage(msg);
      if (msg?.type === 'ready') {
        void panel.webview.postMessage({ type: 'showTab', tab: 'editor' });
      } else if (msg?.type === 'measure' && typeof msg.width === 'number') {
        sizeSidePanel(msg.width, 350); // default the Proser tab to ≈350px
      }
    });
    panel.onDidDispose(() => {
      if (this.panel === panel) {
        this.panel = undefined;
      }
    });
    this.panel = panel;
    // Lock this editor group so files opened from the Explorer / Quick Open land
    // in another (unlocked) group instead of on top of Proser — even when Proser
    // is the focused group. The new panel is the active group right now.
    void vscode.commands.executeCommand('workbench.action.lockEditorGroup');
    return panel;
  }

  private onMessage(msg: {
    type: string;
    command?: string;
    kind?: string;
    scope?: string;
    tense?: string;
    enabled?: boolean;
    id?: string;
    word?: string;
    suggestion?: string;
  }): void {
    switch (msg.type) {
      case 'ready':
        this.postState();
        void this.refreshSpelling(); // populate the panel's Spelling section
        if (this.pendingTab) {
          void this.view?.webview.postMessage({ type: 'showTab', tab: this.pendingTab });
          this.pendingTab = undefined;
        }
        break;
      // Spelling section (editor-tab panel only) — mirror the Spelling sidebar.
      case 'spellReplace':
        if (msg.word && msg.suggestion) {
          void this.spellReplace(msg.word, msg.suggestion);
        }
        break;
      case 'spellAdd':
        if (msg.word) {
          void this.spell.add(msg.word); // fires onDidChange → refresh
        }
        break;
      case 'spellIgnore':
        if (msg.word) {
          void this.spell.ignore(msg.word);
        }
        break;
      case 'spellReveal':
        if (msg.word) {
          void this.spellReveal(msg.word);
        }
        break;
      case 'spellLanguage':
        void vscode.commands.executeCommand(Commands.spellSelectLanguage);
        break;
      case 'command':
        if (msg.command && COMMAND_BUTTONS.has(msg.command)) {
          void vscode.commands.executeCommand(msg.command);
        }
        break;
      case 'check':
        if (isKind(msg.kind)) {
          void this.runOne(msg.kind, false);
        }
        break;
      case 'setScope':
        this.scope = msg.scope === 'folder' ? 'folder' : 'active';
        break;
      case 'setTense':
        this.tense = msg.tense === 'past' || msg.tense === 'present' ? msg.tense : 'auto';
        break;
      case 'setContinuous':
        this.continuous = !!msg.enabled;
        void this.context.workspaceState.update(STATE_ISSUES_AUTOSCAN, this.continuous);
        break;
      case 'go':
        if (msg.id) {
          void this.goTo(msg.id);
        }
        break;
      case 'fix':
        if (msg.id) {
          void this.fix(msg.id);
        }
        break;
      case 'ignore':
        if (msg.id) {
          this.ignored.add(msg.id);
          void this.context.workspaceState.update(STATE_ISSUES_IGNORED, [...this.ignored]);
          this.postState();
        }
        break;
    }
  }

  private merged(): Issue[] {
    const out: Issue[] = [];
    for (const arr of this.issuesByKind.values()) {
      out.push(...arr.filter((i) => !this.ignored.has(i.id)));
    }
    return out;
  }

  private postState(): void {
    this.post({
      type: 'state',
      issues: this.merged(),
      scanning: this.scanning,
      continuous: this.continuous,
      scope: this.scope,
      tense: this.tense,
      detectedTense: this.detectedTense,
      engineOff: this.engineOff,
      ran: [...this.ran]
    });
  }

  /** Posts to every live surface — the side bar view and/or the editor-tab panel. */
  private post(msg: object): void {
    void this.view?.webview.postMessage(msg);
    void this.panel?.webview.postMessage(msg);
  }

  private async runOne(kind: CheckKind, silent: boolean): Promise<void> {
    if (this.scanning) {
      return;
    }
    this.scanning = true;
    this.postState();
    try {
      const res = await runCheck(this.secrets, kind, this.scope, this.tense, silent);
      this.issuesByKind.set(kind, res.issues);
      this.ran.add(kind);
      this.engineOff = res.engineOff;
      if (kind === 'tense') {
        this.detectedTense = res.detectedTense;
      }
    } catch (err) {
      if (!silent) {
        vscode.window.showErrorMessage(
          `Check failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    } finally {
      this.scanning = false;
      this.postState();
    }
  }

  private onDocChange(e: vscode.TextDocumentChangeEvent): void {
    if (!this.continuous || this.scanning || this.ran.size === 0) {
      return;
    }
    const doc = activeMarkdownDoc();
    if (!doc || e.document.uri.toString() !== doc.uri.toString()) {
      return;
    }
    if (this.changeTimer) {
      clearTimeout(this.changeTimer);
    }
    this.changeTimer = setTimeout(() => void this.rescan(), RESCAN_DEBOUNCE_MS);
  }

  /** Re-runs the per-sentence checks that have been run (continuity stays manual —
   *  it's the expensive cross-referential one). */
  private async rescan(): Promise<void> {
    for (const kind of [...this.ran]) {
      if (kind === 'continuity') {
        continue;
      }
      await this.runOne(kind, true);
    }
  }

  private find(id: string): Issue | undefined {
    for (const arr of this.issuesByKind.values()) {
      const hit = arr.find((i) => i.id === id);
      if (hit) {
        return hit;
      }
    }
    return undefined;
  }

  private async goTo(id: string): Promise<void> {
    const issue = this.find(id);
    if (!issue) {
      return;
    }
    const uri = vscode.Uri.parse(issue.uri);
    // Reveal the file in the column it's already open in (or Beside the Proser
    // panel if it isn't open), then highlight the sentence there — never opening
    // a duplicate inside the Proser panel's own group.
    const column = columnForOpenUri(uri) ?? vscode.ViewColumn.Beside;
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE_MARKDOWN_EDITOR, column);
    const revealed = await vscode.commands.executeCommand(
      Commands.revealInPretty,
      issue.uri,
      issue.sentence
    );
    // Fallback: if no Pretty editor took it, select the range in the text editor.
    if (!revealed && issue.offset >= 0) {
      const doc = await vscode.workspace.openTextDocument(uri);
      const range = new vscode.Range(
        doc.positionAt(issue.offset),
        doc.positionAt(issue.offset + issue.length)
      );
      await vscode.window.showTextDocument(doc, { selection: range, viewColumn: column });
    }
  }

  private async fix(id: string): Promise<void> {
    const issue = this.find(id);
    if (!issue) {
      return;
    }
    const replacement = issue.suggestion || (await rewriteIssue(this.secrets, issue, this.tense));
    if (!replacement) {
      return;
    }
    const ok = await applyFix(issue, replacement);
    if (!ok) {
      vscode.window.showWarningMessage('Could not apply the fix — the text changed. Re-scan and try again.');
      return;
    }
    // Drop the fixed issue and re-locate the rest (the edit shifted their offsets).
    const remaining = ([] as Issue[])
      .concat(...this.issuesByKind.values())
      .filter((i) => i.id !== id);
    const relocated = await relocate(remaining);
    this.issuesByKind.clear();
    for (const it of relocated) {
      const arr = this.issuesByKind.get(it.type) ?? [];
      arr.push(it);
      this.issuesByKind.set(it.type, arr);
    }
    this.postState();
  }

  // ── Spelling section (editor-tab panel only) ──────────────────────────────
  private scheduleSpell(): void {
    if (!this.panel) {
      return; // the sidebar uses the standalone Spelling view; only the panel needs this
    }
    if (this.spellTimer) {
      clearTimeout(this.spellTimer);
    }
    this.spellTimer = setTimeout(() => void this.refreshSpelling(), 300);
  }

  /** Computes the active doc's misspellings and posts them to the panel. */
  private async refreshSpelling(): Promise<void> {
    if (!this.panel) {
      return;
    }
    const enabled = this.spell.enabled();
    const language = languageLabel(this.spell.currentLanguage);
    const doc = activeMarkdownDoc();
    if (!doc) {
      this.post({ type: 'spellState', enabled, language, items: [], docName: '' });
      return;
    }
    const text = doc.getText();
    const found = enabled ? await this.spell.misspellings(text) : [];
    const items = found.map((m) => ({
      word: m.word,
      suggestions: m.suggestions,
      count: countWord(text, m.word)
    }));
    this.post({
      type: 'spellState',
      enabled,
      language,
      items,
      docName: doc.uri.path.split('/').pop() ?? ''
    });
  }

  /** Replaces every whole-word occurrence of `word` with `suggestion`. */
  private async spellReplace(word: string, suggestion: string): Promise<void> {
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

  /** Shows the word in the Pretty view (falls back to a text-editor selection),
   *  revealing the file in the column it's already open in — not the panel's. */
  private async spellReveal(word: string): Promise<void> {
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

  private html(webview: vscode.Webview, includeSpelling = false): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'manuscript.js')
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`
    ].join('; ');
    const cmdBtn = (cmd: string, label: string, icon: string, extra = '') =>
      `<button class="pm-btn ${extra}" data-cmd="${cmd}"><span class="pm-ico">${icon}</span>${label}</button>`;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<style>
  :root { ${PROSER_THEME_VARS} }
  body { margin: 0; padding: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }

  /* Tabs */
  #tabs { display: flex; gap: 2px; padding: 0 6px; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { flex: 1; padding: 10px 6px 8px; background: transparent; border: none; border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground); cursor: pointer; font: inherit; font-size: 12px;
    transition: color 0.12s ease, border-color 0.12s ease; }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active { color: var(--vscode-foreground); font-weight: 600;
    border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background)); }
  .panel { padding: 12px; }

  /* Section header */
  .sec { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 600;
    color: var(--vscode-descriptionForeground); margin: 16px 1px 8px; }
  .sec:first-child { margin-top: 2px; }

  /* Scope/Tense — two aligned columns, equal-width selects with a custom caret. */
  .ctlgrid { display: grid; grid-template-columns: auto 1fr; gap: 8px 10px; align-items: center; }
  .ctlgrid > label { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .select-wrap { position: relative; }
  .select-wrap::after { content: ''; position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent;
    border-top: 5px solid currentColor; opacity: 0.55; pointer-events: none; }
  select { -webkit-appearance: none; appearance: none; width: 100%; height: 28px; box-sizing: border-box;
    font: inherit; font-size: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px;
    padding: 0 24px 0 9px; cursor: pointer; transition: border-color 0.12s ease; }
  select:hover { border-color: var(--vscode-focusBorder, var(--vscode-input-border)); }
  select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }

  /* Continuous-scan toggle — custom accent checkbox. */
  .cont { display: flex; align-items: flex-start; gap: 9px; font-size: 12px; line-height: 1.45;
    color: var(--vscode-descriptionForeground); cursor: pointer; margin: 12px 1px 2px; }
  .cont input { appearance: none; -webkit-appearance: none; flex: 0 0 auto; width: 16px; height: 16px; margin: 0;
    border: 1px solid var(--vscode-checkbox-border, var(--vscode-input-border, var(--vscode-panel-border)));
    border-radius: 4px; background: var(--vscode-checkbox-background, var(--vscode-input-background));
    display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
    transition: background 0.12s ease, border-color 0.12s ease; }
  .cont input:checked { background: var(--vscode-button-background); border-color: var(--vscode-button-background); }
  .cont input:checked::after { content: ''; width: 4px; height: 8px; margin-top: -1px;
    border: solid var(--vscode-button-foreground); border-width: 0 2px 2px 0; transform: rotate(45deg); }

  /* Check buttons — color-coded to match their result type. */
  .checks { display: flex; flex-direction: column; gap: 7px; }
  .check { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 36px; box-sizing: border-box;
    padding: 0 11px; cursor: pointer; font: inherit; font-size: 13px; text-align: left; border-radius: 7px;
    color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.10));
    border: 1px solid var(--vscode-panel-border); transition: background 0.12s ease, border-color 0.12s ease; }
  .check:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .check:disabled { opacity: 0.5; cursor: default; }
  .check .dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
  .check .lbl { flex: 1 1 auto; }
  .check-tense .dot { background: var(--proser-opt-1); }
  .check-passive .dot { background: var(--proser-opt-2); }
  .check-continuity .dot { background: var(--proser-opt-3); }

  /* Status / results */
  #eStatus { color: var(--vscode-descriptionForeground); margin: 14px 1px 0; min-height: 16px; font-size: 12px; line-height: 1.45; }
  #eList { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .issue { border: 1px solid var(--vscode-panel-border); border-left-width: 3px; border-radius: 7px; padding: 8px 10px;
    background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06)); }
  .issue.tense { border-left-color: var(--proser-opt-1); }
  .issue.passive { border-left-color: var(--proser-opt-2); }
  .issue.continuity { border-left-color: var(--proser-opt-3); }
  .ihead { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 7px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .loc { font-size: 11px; opacity: 0.6; }
  .sentence { line-height: 1.45; margin: 2px 0; }
  .reason { font-size: 11px; opacity: 0.7; margin: 2px 0; }
  .sugg { font-size: 12px; opacity: 0.85; margin: 2px 0 7px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .actions button { border: 1px solid var(--vscode-panel-border); background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-foreground); cursor: pointer; font: inherit; font-size: 12px; padding: 3px 10px; border-radius: 5px;
    transition: background 0.12s ease; }
  .actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .actions .fix { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
  .actions .fix:hover { background: var(--vscode-button-hoverBackground); }
  .actions button:disabled { opacity: 0.5; cursor: default; }

  /* Insert / Settings buttons — icon in a subtle badge. */
  .pm-btn { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 36px; box-sizing: border-box;
    text-align: left; margin: 0 0 7px; padding: 0 10px; cursor: pointer; font: inherit; font-size: 13px;
    color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.10));
    border: 1px solid var(--vscode-panel-border); border-radius: 7px; transition: background 0.12s ease, border-color 0.12s ease; }
  .pm-btn:hover { background: var(--vscode-toolbar-hoverBackground); border-color: var(--vscode-focusBorder); }
  .pm-ico { flex: 0 0 auto; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center;
    font-size: 13px; line-height: 1; border-radius: 5px;
    background: var(--vscode-badge-background, rgba(128,128,128,0.2)); color: var(--vscode-badge-foreground, var(--vscode-foreground)); }
  .pm-export { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .pm-export:hover { background: var(--vscode-button-hoverBackground); border-color: transparent; }
  .pm-export .pm-ico { background: rgba(255,255,255,0.18); color: var(--vscode-button-foreground); }
  .pm-note { font-size: 11px; color: var(--vscode-descriptionForeground); margin: 12px 1px 2px; line-height: 1.5; }

  /* Spelling section (editor-tab panel only) */
  .sp-sec { display: flex; align-items: baseline; justify-content: space-between; margin-top: 20px; }
  .sp-lang { text-transform: none; letter-spacing: 0; font-weight: 400; font-size: 11px;
    color: var(--vscode-textLink-foreground); cursor: pointer; }
  .sp-lang:hover { text-decoration: underline; }
  #spStatus { color: var(--vscode-descriptionForeground); margin: 2px 1px 0; min-height: 16px; font-size: 12px; line-height: 1.45; }
  #spList { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
  .sp-item { border: 1px solid var(--vscode-panel-border); border-left: 3px solid var(--vscode-editorError-foreground, #f14c4c);
    border-radius: 7px; padding: 8px 10px; background: var(--vscode-editorWidget-background, rgba(128,128,128,0.06)); }
  .sp-word { display: flex; align-items: baseline; gap: 8px; margin-bottom: 5px; }
  .sp-wordbtn { border: none; background: transparent; color: var(--vscode-foreground); cursor: pointer; font: inherit;
    font-weight: 600; padding: 0; text-decoration: underline wavy var(--vscode-editorError-foreground, #f14c4c);
    text-decoration-skip-ink: none; }
  .sp-wordbtn:hover { color: var(--vscode-textLink-foreground); }
  .sp-count { font-size: 11px; opacity: 0.6; }
  .sp-suggs { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 7px; }
  .sp-sugg { border: 1px solid var(--vscode-panel-border); border-radius: 999px; cursor: pointer; font: inherit; font-size: 12px;
    padding: 2px 10px; color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12)); }
  .sp-sugg:hover { background: var(--vscode-toolbar-hoverBackground); }
  .sp-none { font-size: 12px; opacity: 0.55; }
  .sp-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .sp-actions button { border: 1px solid var(--vscode-panel-border); background: transparent; color: var(--vscode-foreground);
    cursor: pointer; font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 5px; transition: background 0.12s ease; }
  .sp-actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .sp-ignore { color: var(--vscode-descriptionForeground) !important; }
</style>
</head>
<body>
  <div id="tabs">
    <button class="tab active" data-tab="editor">Editor</button>
    <button class="tab" data-tab="insert">Insert</button>
    <button class="tab" data-tab="settings">Settings</button>
  </div>

  <div class="panel" data-tab="editor">
    <div class="ctlgrid">
      <label for="scope">Scope</label>
      <span class="select-wrap">
        <select id="scope">
          <option value="active">This file</option>
          <option value="folder">Whole folder</option>
        </select>
      </span>
      <label for="tense">Tense</label>
      <span class="select-wrap">
        <select id="tense">
          <option value="auto">Auto</option>
          <option value="past">Past</option>
          <option value="present">Present</option>
        </select>
      </span>
    </div>
    <label class="cont"><input type="checkbox" id="continuous" /><span>Scan continuously — re-check tense &amp; passive voice as you write</span></label>
    <div class="sec">Checks</div>
    <div class="checks">
      <button class="check check-tense" data-check="tense"><span class="dot"></span><span class="lbl">Check tense usage</span></button>
      <button class="check check-passive" data-check="passive"><span class="dot"></span><span class="lbl">Check passive voice</span></button>
      <button class="check check-continuity" data-check="continuity"><span class="dot"></span><span class="lbl">Check continuity</span></button>
    </div>
    <div id="eStatus"></div>
    <div id="eList"></div>
    ${
      includeSpelling
        ? `<div class="sec sp-sec">Spelling <span id="spLang" class="sp-lang"></span></div>
    <div id="spStatus"></div>
    <div id="spList"></div>`
        : ''
    }
  </div>

  <div class="panel" data-tab="insert" style="display:none">
    ${cmdBtn(Commands.manuscriptNewChapter, 'New Chapter', '¶')}
    ${cmdBtn(Commands.manuscriptDivider, 'Add Divider', '―')}
    ${cmdBtn(Commands.manuscriptSceneBreak, 'Add Scene Break', '✳')}
    <div class="pm-note">New Chapter creates a file right after the current one. Dividers and scene breaks insert at your cursor.</div>
  </div>

  <div class="panel" data-tab="settings" style="display:none">
    <div class="sec">Manuscript</div>
    ${cmdBtn(Commands.manuscriptTitlePage, 'Title &amp; Author…', '✎')}
    <div class="sec">Synonyms &amp; Antonyms</div>
    ${cmdBtn(Commands.thesaurusSelectEngine, 'Synonym Engine…', '⇄')}
    <div class="pm-note">Pick the local AI model or a dictionary for synonym &amp; antonym lookups (right-click a word → Synonyms).</div>
    <div class="sec">Export</div>
    ${cmdBtn(Commands.manuscriptExportDocx, 'Export DOCX', '⤓', 'pm-export')}
    ${cmdBtn(Commands.manuscriptExportPdf, 'Export PDF', '⤓', 'pm-export')}
    <div class="pm-note">Standard Manuscript Format (Courier 12pt, double-spaced, 1" margins). Choose this file or the whole folder from the Pretty toolbar's Export menu.</div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function isKind(v: unknown): v is CheckKind {
  return v === 'tense' || v === 'passive' || v === 'continuity';
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

/** Whole-word (letter/apostrophe/hyphen boundaries), case-sensitive matcher. */
function wordRegex(word: string): RegExp {
  const esc = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}'’-])${esc}(?![\\p{L}'’-])`, 'gu');
}
