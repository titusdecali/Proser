import * as vscode from 'vscode';
import { ConfigKeys, EXTENSION_ID } from '../../constants';

type EngineKind = 'off' | 'openrouter' | 'ollama';

/** The active AI model name for display (or 'off'), from settings. Used by the
 *  Brainstorm header and the thesaurus/Settings copy. */
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
