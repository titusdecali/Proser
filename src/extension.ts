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
import { startModelStatePolling } from './features/ai/modelState';
import { registerBrainstorm } from './features/ai/brainstormPanel';
import { registerStoryMemory } from './features/storyMemory/register';
import { registerPrettyEditor } from './features/wysiwyg/ProserEditorProvider';
import { registerManuscript } from './features/manuscript/register';
import { registerChaptersView } from './features/manuscript/chaptersView';

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
  startModelStatePolling(context); // footer: live "Loading/Ready" + VRAM for the one model
  registerStoryMemory(context); // M12 (Story Memory engine — must precede Brainstorm so it can pull canon)
  registerBrainstorm(context); // M11 (AI brainstorming chat panel)
  registerPrettyEditor(context, spell); // M7 (Pretty editor + inline spelling squiggles)
  registerChaptersView(context); // M8 (Chapters list in the Proser sidebar)
  registerManuscript(context, spell); // M8 (tabbed sidebar: Editor checks / Insert / Settings + panel Spelling)
  registerSpellingView(context, spell); // M10 (dedicated Spelling sidebar)
}

export function deactivate(): void {
  // Disposables registered via context.subscriptions are cleaned up by VS Code.
}
