import * as vscode from 'vscode';
import { registerStatusBarWordCount } from './features/wordcountStatus/statusBarWordCount';
import { registerExplorerWordCount } from './features/wordcountExplorer/explorerCount';
import { registerThesaurus } from './features/thesaurus/thesaurusCommands';
import { registerSpellCheck } from './features/spellcheck/spellChecker';
import { SpellService } from './features/spellcheck/spellService';
import { registerSpellingView } from './features/spellcheck/spellingView';
import { registerQualityLint } from './features/qualityLint/qualityLinter';
import { registerOutline } from './features/outline/documentSymbols';
import { registerWritingModes } from './features/focusMode/focusMode';
import { registerAI } from './features/ai/registerAI';
import { registerAiModelStatus } from './features/ai/aiModelStatus';
import { registerPrettyEditor } from './features/wysiwyg/ProserEditorProvider';
import { registerManuscript } from './features/manuscript/register';

/**
 * Proser extension entry point. Each feature is registered by a small
 * `register*` function that pushes its disposables onto `context.subscriptions`.
 * Milestones add their registrations here.
 */
export function activate(context: vscode.ExtensionContext): void {
  const spell = new SpellService(context); // shared by Pretty squiggles + Spelling sidebar

  registerStatusBarWordCount(context); // M1
  registerExplorerWordCount(context); // M2
  registerThesaurus(context); // M3
  registerSpellCheck(context, spell); // M4 (Add to dictionary command)
  registerQualityLint(context); // M4
  registerOutline(context); // M5
  registerWritingModes(context); // M5 (focus + typewriter)
  registerAI(context); // M6
  registerAiModelStatus(context); // M6 (status-bar model indicator + quick switch/delete)
  registerPrettyEditor(context, spell); // M7 (Pretty editor + inline spelling squiggles)
  registerManuscript(context); // M8 (tabbed sidebar: Editor checks / Insert / Settings)
  registerSpellingView(context, spell); // M10 (dedicated Spelling sidebar)
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions are cleaned up by VS Code.
}
