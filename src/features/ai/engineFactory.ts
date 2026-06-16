import * as vscode from 'vscode';
import { ConfigKeys, EXTENSION_ID } from '../../constants';
import { AiClient } from './AiClient';
import { OpenRouterClient } from './openRouterClient';
import { OllamaClient } from './ollamaClient';
import { SecretStore } from './secretStore';
import { pickLocalModel } from './localModelPicker';

export type EngineKind = 'off' | 'openrouter' | 'ollama';

function config() {
  return vscode.workspace.getConfiguration(EXTENSION_ID);
}

/** Builds a client from current config + secrets, or undefined when AI is off.
 *  AI is also disabled in untrusted workspaces (network + workspace-influenced
 *  config), matching the declared untrustedWorkspaces capability. */
export async function createEngine(secrets: SecretStore): Promise<AiClient | undefined> {
  if (!vscode.workspace.isTrusted) {
    return undefined;
  }
  const cfg = config();
  const kind = cfg.get<EngineKind>(ConfigKeys.aiEngine, 'off');
  if (kind === 'openrouter') {
    return new OpenRouterClient(
      cfg.get<string>(ConfigKeys.aiOpenRouterModel, 'meta-llama/llama-4-scout'),
      await secrets.getApiKey(),
      cfg.get<boolean>(ConfigKeys.aiOpenRouterPreferGroq, true)
    );
  }
  if (kind === 'ollama') {
    return new OllamaClient(
      cfg.get<string>(ConfigKeys.aiOllamaEndpoint, 'http://localhost:11434'),
      cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b')
    );
  }
  return undefined;
}

/**
 * Returns a ready-to-use client, guiding the user through setup when needed
 * (choosing an engine, entering an API key, installing Ollama, or pulling a
 * model). Returns undefined if the user backs out.
 */
export async function prepareEngine(secrets: SecretStore): Promise<AiClient | undefined> {
  if (!vscode.workspace.isTrusted) {
    vscode.window.showWarningMessage(
      'Proser AI features are disabled in untrusted workspaces. Trust this workspace to enable them.'
    );
    return undefined;
  }
  let kind = config().get<EngineKind>(ConfigKeys.aiEngine, 'off');

  if (kind === 'off') {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'OpenRouter (cloud)', detail: 'Fast, needs an API key and internet.', engineKind: 'openrouter' as const },
        { label: 'Ollama (local)', detail: 'Private and offline, needs Ollama installed.', engineKind: 'ollama' as const }
      ],
      { title: 'Enable Proser AI', placeHolder: 'Choose an AI backend' }
    );
    if (!choice) {
      return undefined;
    }
    kind = choice.engineKind;
    await config().update(ConfigKeys.aiEngine, kind, vscode.ConfigurationTarget.Global);
  }

  let client = await createEngine(secrets);
  if (!client) {
    return undefined;
  }

  let state = await client.isReady();
  if (state.ready) {
    return client;
  }

  if (kind === 'openrouter') {
    const set = await secrets.promptForApiKey();
    if (!set) {
      return undefined;
    }
    client = await createEngine(secrets);
    return client;
  }

  if (kind === 'ollama') {
    if (state.needsPull && client instanceof OllamaClient) {
      const model = config().get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b');
      const pull = await vscode.window.showInformationMessage(
        `The local model “${model}” isn't downloaded yet. Pull it now? (several GB)`,
        'Pull',
        'Cancel'
      );
      if (pull !== 'Pull') {
        return undefined;
      }
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Pulling ${model}…`, cancellable: true },
          async (progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            await (client as OllamaClient).pull(progress, controller.signal);
          }
        );
      } catch (err) {
        if (!isAbort(err)) {
          vscode.window.showErrorMessage(`Could not pull model: ${describe(err)}`);
        }
        return undefined;
      }
      state = await client.isReady();
      return state.ready ? client : undefined;
    }

    // Ollama not reachable — it may be installed but simply not running.
    const action = await vscode.window.showWarningMessage(
      `${state.reason ?? 'Ollama is not available.'} If it's installed, it may just need to be started.`,
      'Start Ollama',
      'Install Ollama'
    );
    if (action === 'Start Ollama') {
      const reachable = await startOllamaAndWait(client);
      if (reachable) {
        // Re-enter the flow: now reachable, it will proceed (or offer the pull).
        return prepareEngine(secrets);
      }
      const retry = await vscode.window.showErrorMessage(
        "Couldn't reach Ollama after trying to start it. Make sure it's installed and running, then try again.",
        'Install Ollama'
      );
      if (retry === 'Install Ollama') {
        void vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
      }
      return undefined;
    }
    if (action === 'Install Ollama') {
      void vscode.env.openExternal(vscode.Uri.parse('https://ollama.com/download'));
    }
    return undefined;
  }

  return undefined;
}

/** Launches the local Ollama server, then polls until it responds (or times
 *  out). Returns true once the server is reachable. */
async function startOllamaAndWait(client: AiClient): Promise<boolean> {
  if (!(await launchOllama())) {
    return false;
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Starting Ollama…' },
    async () => {
      for (let i = 0; i < 20; i++) {
        await delay(500);
        const s = await client.isReady();
        // ready OR needsPull both mean the server answered (it's reachable).
        if (s.ready || s.needsPull) {
          return true;
        }
      }
      return false;
    }
  );
}

/** Spawns the Ollama server detached. On macOS launches the app; elsewhere runs
 *  `ollama serve`. Resolves false if the binary/app can't be started. */
function launchOllama(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { spawn } = require('child_process') as typeof import('child_process');
      const isMac = process.platform === 'darwin';
      const cmd = isMac ? 'open' : 'ollama';
      const args = isMac ? ['-a', 'Ollama'] : ['serve'];
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
      let errored = false;
      child.on('error', () => {
        errored = true;
        resolve(false);
      });
      child.unref();
      // Assume launched only if no spawn error (e.g. ENOENT) fired first.
      setTimeout(() => {
        if (!errored) {
          resolve(true);
        }
      }, 500);
    } catch {
      resolve(false);
    }
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Curated, spec-recommended local model picker, then sets up + pulls it. */
export async function setupLocalEngine(secrets: SecretStore): Promise<void> {
  const cfg = config();
  const endpoint = cfg.get<string>(ConfigKeys.aiOllamaEndpoint, 'http://localhost:11434');
  const current = cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b');

  const model = await pickLocalModel(endpoint, current);
  if (!model) {
    return;
  }

  await config().update(ConfigKeys.aiEngine, 'ollama', vscode.ConfigurationTarget.Global);
  await config().update(ConfigKeys.aiOllamaModel, model, vscode.ConfigurationTarget.Global);
  await prepareEngine(secrets); // triggers start/pull guidance as needed
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}
