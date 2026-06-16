import * as vscode from 'vscode';
import { registerStatusBarWordCount } from './features/wordcountStatus/statusBarWordCount';
import { registerExplorerWordCount } from './features/wordcountExplorer/explorerCount';
import { registerThesaurus } from './features/thesaurus/thesaurusCommands';
import { registerSpellCheck } from './features/spellcheck/spellChecker';
import { registerQualityLint } from './features/qualityLint/qualityLinter';
import { registerOutline } from './features/outline/documentSymbols';
import { registerWritingModes } from './features/focusMode/focusMode';
import { registerAI } from './features/ai/registerAI';
import { registerPrettyEditor } from './features/wysiwyg/ProserEditorProvider';
import { registerManuscript } from './features/manuscript/register';

/**
 * Proser extension entry point. Each feature is registered by a small
 * `register*` function that pushes its disposables onto `context.subscriptions`.
 * Milestones add their registrations here.
 */
export function activate(context: vscode.ExtensionContext): void {
  registerStatusBarWordCount(context); // M1
  registerExplorerWordCount(context); // M2
  registerThesaurus(context); // M3
  registerSpellCheck(context); // M4
  registerQualityLint(context); // M4
  registerOutline(context); // M5
  registerWritingModes(context); // M5 (focus + typewriter)
  registerAI(context); // M6
  registerPrettyEditor(context); // M7
  registerManuscript(context); // M8 (manuscript sidebar + SMF export)
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions are cleaned up by VS Code.
}
