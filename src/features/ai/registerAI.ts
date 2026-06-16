import * as vscode from 'vscode';
import { Commands, ConfigKeys, EXTENSION_ID } from '../../constants';
import { SecretStore } from './secretStore';
import { reviseWithAI } from './reviseCommand';
import { setupLocalEngine, EngineKind } from './engineFactory';
import { pickOpenRouterModel } from './modelPicker';

/** Registers the AI commands. The thesaurus module wires its own optional
 *  AI-synonyms path; this owns key management, model selection, local setup,
 *  and "Revise with AI". */
export function registerAI(context: vscode.ExtensionContext): void {
  const secrets = new SecretStore(context.secrets);

  function cfg() {
    return vscode.workspace.getConfiguration(EXTENSION_ID);
  }

  async function ensureOpenRouterSelected(): Promise<void> {
    if (cfg().get<EngineKind>(ConfigKeys.aiEngine, 'off') === 'off') {
      await cfg().update(ConfigKeys.aiEngine, 'openrouter', vscode.ConfigurationTarget.Global);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(Commands.reviseWithAI, () => reviseWithAI(secrets)),

    vscode.commands.registerCommand(Commands.aiSetApiKey, async () => {
      if (await secrets.promptForApiKey()) {
        await ensureOpenRouterSelected();
        vscode.window.showInformationMessage('OpenRouter API key saved to your keychain.');
      }
    }),

    vscode.commands.registerCommand(Commands.aiClearKey, async () => {
      await secrets.clear();
      vscode.window.showInformationMessage('OpenRouter API key cleared.');
    }),

    vscode.commands.registerCommand(Commands.aiSelectModel, async () => {
      const current = cfg().get<string>(ConfigKeys.aiOpenRouterModel, 'meta-llama/llama-4-scout');
      const slug = await pickOpenRouterModel(current);
      if (slug) {
        await cfg().update(ConfigKeys.aiOpenRouterModel, slug, vscode.ConfigurationTarget.Global);
        await ensureOpenRouterSelected();
        vscode.window.showInformationMessage(`Proser AI model set to ${slug}.`);
      }
    }),

    vscode.commands.registerCommand(Commands.aiSetupLocal, () => setupLocalEngine(secrets)),
    vscode.commands.registerCommand(Commands.aiSelectLocalModel, () => setupLocalEngine(secrets))
  );
}
