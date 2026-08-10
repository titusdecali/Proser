import * as vscode from 'vscode';
import { registerStatusBarWordCount } from './features/wordcountStatus/statusBarWordCount';
import { registerExplorerWordCount } from './features/wordcountExplorer/explorerCount';
import { registerDailyGoal } from './features/dailyGoal/dailyGoal';
import { registerThesaurus } from './features/thesaurus/thesaurusCommands';
import { registerSpellCheck } from './features/spellcheck/spellChecker';
import { SpellService } from './features/spellcheck/spellService';
import { registerSpellingView } from './features/spellcheck/spellingView';
import { registerQualityLint } from './features/qualityLint/qualityLinter';
import { registerOutline } from './features/outline/documentSymbols';
import { registerWritingModes } from './features/focusMode/focusMode';
import { registerAI } from './features/ai/registerAI';
import { unloadEditorModelOnShutdown } from './features/ai/engineFactory';
import { registerKeepModelWarm } from './features/ai/keepWarm';
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
  registerDailyGoal(context); // M13 (words written today + daily target, bottom-right)
  registerThesaurus(context); // M3
  registerSpellCheck(context, spell); // M4 (Add to dictionary command)
  registerQualityLint(context); // M4
  registerOutline(context); // M5
  registerWritingModes(context); // M5 (focus + typewriter)
  registerAI(context); // M6
  registerKeepModelWarm(context); // hold the local model resident while you type (keep_alive)
  startModelStatePolling(context); // footer: live "Loading/Ready" + VRAM for the one model
  registerStoryMemory(context); // M12 (Story Memory engine — must precede Brainstorm so it can pull canon)
  registerBrainstorm(context); // M11 (AI brainstorming chat panel)
  registerPrettyEditor(context, spell); // M7 (Pretty editor + inline spelling squiggles)
  registerChaptersView(context); // M8 (Chapters list in the Proser sidebar)
  registerManuscript(context, spell); // M8 (tabbed sidebar: Editor checks / Insert / Settings + panel Spelling)
  registerSpellingView(context, spell); // M10 (dedicated Spelling sidebar)
}

export async function deactivate(): Promise<void> {
  // Disposables registered via context.subscriptions are cleaned up by VS Code.
  // Additionally free the local editor model so Ollama doesn't keep it (and its RAM)
  // resident for the rest of its 8h keep-alive after the window closes. Best-effort:
  // VS Code only briefly awaits deactivate, and a local unload POST is quick.
  await unloadEditorModelOnShutdown();
}
