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
import { SecretStore } from '../ai/secretStore';
import { activeMarkdownDoc } from './compile';
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
  Commands.manuscriptExportPdf
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
  private pendingTab?: string;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.secrets = new SecretStore(context.secrets);
    this.continuous = context.workspaceState.get<boolean>(STATE_ISSUES_AUTOSCAN, false);
    this.ignored = new Set(context.workspaceState.get<string[]>(STATE_ISSUES_IGNORED, []));
    context.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocChange(e))
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

  /** Toggles the sidebar on the Editor (checks) tab (the Pretty toolbar button):
   *  closes the sidebar when this view is already showing, otherwise opens/focuses
   *  it on the Editor tab. */
  async toggleEditor(): Promise<void> {
    if (this.view?.visible) {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      return;
    }
    try {
      await vscode.commands.executeCommand('workbench.view.extension.proser');
    } catch {
      /* container id can vary — ignore */
    }
    await vscode.commands.executeCommand(`${MANUSCRIPT_VIEW_ID}.focus`);
    if (this.view) {
      void this.view.webview.postMessage({ type: 'showTab', tab: 'editor' });
    } else {
      this.pendingTab = 'editor';
    }
  }

  private onMessage(msg: {
    type: string;
    command?: string;
    kind?: string;
    scope?: string;
    tense?: string;
    enabled?: boolean;
    id?: string;
  }): void {
    switch (msg.type) {
      case 'ready':
        this.postState();
        if (this.pendingTab) {
          void this.view?.webview.postMessage({ type: 'showTab', tab: this.pendingTab });
          this.pendingTab = undefined;
        }
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
    void this.view?.webview.postMessage({
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
    // Open (or focus) the file in the Pretty editor and reveal the sentence there,
    // so Go stays inside the Proser UI rather than the raw Markdown editor.
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE_MARKDOWN_EDITOR);
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
      await vscode.window.showTextDocument(doc, { selection: range });
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

  private html(webview: vscode.Webview): string {
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
  body { margin: 0; padding: 0; font: var(--vscode-font-size) var(--vscode-font-family); color: var(--vscode-foreground); }
  #tabs { display: flex; border-bottom: 1px solid var(--vscode-panel-border); }
  .tab { flex: 1; padding: 9px 4px; background: transparent; border: none; border-bottom: 2px solid transparent;
    color: var(--vscode-descriptionForeground); cursor: pointer; font: inherit; font-size: 12px; }
  .tab:hover { color: var(--vscode-foreground); }
  .tab.active { color: var(--vscode-foreground); font-weight: 600; border-bottom-color: var(--vscode-focusBorder, var(--vscode-button-background)); }
  .panel { padding: 10px; }

  /* Label + control in two aligned columns, so both selects fill the same width. */
  .ctlgrid { display: grid; grid-template-columns: auto 1fr; gap: 8px 10px; align-items: center; margin-bottom: 10px; }
  .ctlgrid > label { font-size: 12px; opacity: 0.9; }
  .select-wrap { position: relative; }
  /* Custom caret (native arrow removed below) — centered on the right. */
  .select-wrap::after { content: ''; position: absolute; right: 10px; top: 50%; transform: translateY(-50%);
    width: 0; height: 0; border-left: 4px solid transparent; border-right: 4px solid transparent;
    border-top: 5px solid currentColor; opacity: 0.55; pointer-events: none; }
  select { -webkit-appearance: none; appearance: none; width: 100%; height: 28px; box-sizing: border-box;
    font: inherit; font-size: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 6px;
    padding: 0 24px 0 9px; cursor: pointer; transition: border-color 0.12s ease; }
  select:hover { border-color: var(--vscode-focusBorder, var(--vscode-input-border)); }
  select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .cont { display: flex; align-items: center; gap: 6px; font-size: 12px; opacity: 0.9; margin-bottom: 10px; }
  .checks { display: flex; flex-direction: column; gap: 6px; }
  /* Consistent secondary action buttons (shared with the Insert/Settings .pm-btn). */
  .checks button { display: flex; align-items: center; width: 100%; min-height: 32px; box-sizing: border-box;
    padding: 0 11px; cursor: pointer; font: inherit; font-size: 13px; text-align: left; border-radius: 6px;
    color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12));
    border: 1px solid var(--vscode-panel-border); transition: background 0.12s ease; }
  .checks button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .checks button:disabled { opacity: 0.5; cursor: default; }

  #eStatus { opacity: 0.75; margin: 10px 0; min-height: 16px; font-size: 12px; }
  #eList { display: flex; flex-direction: column; gap: 8px; }
  .issue { border: 1px solid var(--vscode-panel-border); border-left-width: 3px; border-radius: 6px; padding: 7px 9px;
    background: var(--vscode-editorWidget-background, transparent); }
  .issue.passive { border-left-color: var(--vscode-charts-yellow, #dcdcaa); }
  .issue.tense { border-left-color: var(--vscode-charts-purple, #c586c0); }
  .issue.continuity { border-left-color: var(--vscode-charts-red, #f14c4c); }
  .ihead { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; }
  .badge { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 6px; border-radius: 999px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .loc { font-size: 11px; opacity: 0.6; }
  .sentence { line-height: 1.4; margin: 2px 0; }
  .reason { font-size: 11px; opacity: 0.7; margin: 2px 0; }
  .sugg { font-size: 12px; opacity: 0.85; margin: 2px 0 6px; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .actions button { border: 1px solid var(--vscode-panel-border); background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-foreground); cursor: pointer; font: inherit; font-size: 12px; padding: 3px 9px; border-radius: 4px; }
  .actions button:hover { background: var(--vscode-toolbar-hoverBackground); }
  .actions .fix { color: var(--vscode-button-foreground); background: var(--vscode-button-background); border-color: transparent; }
  .actions button:disabled { opacity: 0.5; cursor: default; }

  .pm-btn { display: flex; align-items: center; gap: 8px; width: 100%; min-height: 32px; box-sizing: border-box;
    text-align: left; margin: 6px 0; padding: 0 11px; cursor: pointer; font: inherit; font-size: 13px;
    color: var(--vscode-foreground); background: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.12));
    border: 1px solid var(--vscode-panel-border); border-radius: 6px; transition: background 0.12s ease; }
  .pm-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
  .pm-ico { font-size: 14px; width: 16px; text-align: center; opacity: 0.9; }
  .pm-export { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .pm-export:hover { background: var(--vscode-button-hoverBackground); }
  .pm-note { font-size: 11px; opacity: 0.6; margin: 10px 2px 2px; line-height: 1.4; }
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
    <label class="cont"><input type="checkbox" id="continuous" /> Scan continuously (re-check tense &amp; passive voice as you write)</label>
    <div class="checks">
      <button data-check="tense">Check correct tense usage</button>
      <button data-check="passive">Check passive voice</button>
      <button data-check="continuity">Check continuity</button>
    </div>
    <div id="eStatus"></div>
    <div id="eList"></div>
  </div>

  <div class="panel" data-tab="insert" style="display:none">
    ${cmdBtn(Commands.manuscriptNewChapter, 'New Chapter', '¶')}
    ${cmdBtn(Commands.manuscriptDivider, 'Add Divider', '―')}
    ${cmdBtn(Commands.manuscriptSceneBreak, 'Add Scene Break', '✳')}
  </div>

  <div class="panel" data-tab="settings" style="display:none">
    ${cmdBtn(Commands.manuscriptTitlePage, 'Title &amp; Author…', '✎')}
    ${cmdBtn(Commands.manuscriptExportDocx, 'Export DOCX', '⤓', 'pm-export')}
    ${cmdBtn(Commands.manuscriptExportPdf, 'Export PDF', '⤓', 'pm-export')}
    <div class="pm-note">Exports compile into Standard Manuscript Format (Courier 12pt, double-spaced, 1" margins). Choose this file or the whole folder from the Pretty toolbar's Export menu.</div>
  </div>

  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function isKind(v: unknown): v is CheckKind {
  return v === 'tense' || v === 'passive' || v === 'continuity';
}
