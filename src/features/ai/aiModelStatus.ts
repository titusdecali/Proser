import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID, VIEW_TYPE_MARKDOWN_EDITOR } from '../../constants';

type EngineKind = 'off' | 'openrouter' | 'ollama';

/** The active AI model name for display (or 'off'), from settings. Shared by the
 *  status bar and the pretty-view footer so both read the same source. */
export function currentModelName(): string {
  const cfg = vscode.workspace.getConfiguration(EXTENSION_ID);
  const engine = cfg.get<EngineKind>(ConfigKeys.aiEngine, 'off');
  if (engine === 'ollama') {
    return cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b');
  }
  if (engine === 'openrouter') {
    return cfg.get<string>(ConfigKeys.aiOpenRouterModel, 'meta-llama/llama-4-scout');
  }
  return 'off';
}

/** True when the active tab is the Proser pretty editor, which shows the model
 *  in its own page footer — so the status-bar copy would just be redundant. */
function prettyEditorActive(): boolean {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE_MARKDOWN_EDITOR;
}

/**
 * Bottom-right status-bar control showing the active AI model. Clicking it opens
 * the local model picker — the same dropdown as "Select Local AI Model", which
 * also lets you delete pulled models to free disk space. Hidden while the pretty
 * editor is active (its page footer shows the model instead).
 */
export function registerAiModelStatus(context: vscode.ExtensionContext): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  item.command = Commands.aiSelectLocalModel;
  context.subscriptions.push(item);

  function render(): void {
    if (prettyEditorActive()) {
      item.hide();
      return;
    }
    const engine = vscode.workspace.getConfiguration(EXTENSION_ID).get<EngineKind>(ConfigKeys.aiEngine, 'off');
    const hint =
      engine === 'ollama'
        ? 'Local AI (Ollama) — click to switch model or delete pulled models'
        : engine === 'openrouter'
          ? 'Cloud AI (OpenRouter) — click to choose or manage local models'
          : 'Proser AI is off — click to set up a local model';
    item.text = `$(sparkle) Model: ${currentModelName()}`;
    item.tooltip = hint;
    item.show();
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiEngine}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiOllamaModel}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiOpenRouterModel}`)
      ) {
        render();
      }
    }),
    // Toggle visibility as the user moves between the pretty editor and other tabs.
    vscode.window.tabGroups.onDidChangeTabGroups(() => render()),
    vscode.window.tabGroups.onDidChangeTabs(() => render()),
    vscode.window.onDidChangeActiveTextEditor(() => render())
  );

  render();
}
