import * as vscode from 'vscode';
import { Commands, MARKDOWN_LANGUAGE_ID } from '../../constants';

/**
 * Two independent writing modes:
 *  - Focus: dims every paragraph except the one under the cursor.
 *  - Typewriter: keeps the cursor line vertically centered.
 * They share one set of listeners, created when either is on and disposed when
 * both are off. Costs nothing when both are off.
 */
export function registerWritingModes(context: vscode.ExtensionContext): void {
  let focusEnabled = false;
  let typewriterEnabled = false;
  let dim: vscode.TextEditorDecorationType | undefined;
  const listeners: vscode.Disposable[] = [];

  function isMarkdown(editor: vscode.TextEditor | undefined): editor is vscode.TextEditor {
    return !!editor && editor.document.languageId === MARKDOWN_LANGUAGE_ID;
  }

  function clearDim(): void {
    if (!dim) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(dim, []);
    }
  }

  function applyDim(editor: vscode.TextEditor | undefined): void {
    if (!focusEnabled || !dim || !isMarkdown(editor)) {
      return;
    }
    const doc = editor.document;
    const cursorLine = editor.selection.active.line;

    let start = cursorLine;
    while (start > 0 && doc.lineAt(start - 1).text.trim() !== '') {
      start--;
    }
    let end = cursorLine;
    while (end < doc.lineCount - 1 && doc.lineAt(end + 1).text.trim() !== '') {
      end++;
    }

    const dimmed: vscode.Range[] = [];
    if (start > 0) {
      dimmed.push(new vscode.Range(0, 0, start, 0));
    }
    if (end < doc.lineCount - 1) {
      dimmed.push(
        new vscode.Range(end + 1, 0, doc.lineCount - 1, doc.lineAt(doc.lineCount - 1).text.length)
      );
    }
    editor.setDecorations(dim, dimmed);
  }

  function center(editor: vscode.TextEditor | undefined): void {
    if (!typewriterEnabled || !isMarkdown(editor)) {
      return;
    }
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenter);
  }

  function startListeners(): void {
    if (listeners.length > 0) {
      return;
    }
    listeners.push(
      vscode.window.onDidChangeTextEditorSelection((e) => {
        if (!isMarkdown(e.textEditor)) {
          return;
        }
        applyDim(e.textEditor);
        center(e.textEditor);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        clearDim();
        applyDim(editor);
        center(editor);
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === e.document) {
          applyDim(editor);
        }
      })
    );
  }

  function stopListenersIfIdle(): void {
    if (focusEnabled || typewriterEnabled) {
      return;
    }
    clearDim();
    while (listeners.length > 0) {
      listeners.pop()!.dispose();
    }
    dim?.dispose();
    dim = undefined;
  }

  async function setKey(key: string, value: boolean): Promise<void> {
    await vscode.commands.executeCommand('setContext', key, value);
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.toggleFocusMode, async () => {
      focusEnabled = !focusEnabled;
      if (focusEnabled) {
        dim ??= vscode.window.createTextEditorDecorationType({ opacity: '0.35' });
        startListeners();
        applyDim(vscode.window.activeTextEditor);
      } else {
        clearDim();
      }
      stopListenersIfIdle();
      await setKey('proser.focusMode', focusEnabled);
      vscode.window.setStatusBarMessage(`$(eye) Focus mode ${focusEnabled ? 'on' : 'off'}`, 2000);
    }),

    vscode.commands.registerCommand(Commands.toggleTypewriterMode, async () => {
      typewriterEnabled = !typewriterEnabled;
      if (typewriterEnabled) {
        startListeners();
        center(vscode.window.activeTextEditor);
      }
      stopListenersIfIdle();
      await setKey('proser.typewriterMode', typewriterEnabled);
      vscode.window.setStatusBarMessage(
        `$(arrow-both) Typewriter mode ${typewriterEnabled ? 'on' : 'off'}`,
        2000
      );
    }),

    {
      dispose: () => {
        focusEnabled = false;
        typewriterEnabled = false;
        stopListenersIfIdle();
      }
    }
  );
}
