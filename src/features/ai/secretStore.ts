import * as vscode from 'vscode';
import { SECRET_OPENROUTER_API_KEY } from '../../constants';

/**
 * Thin wrapper over vscode.SecretStorage for the OpenRouter API key. The key
 * lives only in the OS keychain — never in settings, globalState, logs, or
 * telemetry.
 */
export class SecretStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  getApiKey(): Thenable<string | undefined> {
    return this.secrets.get(SECRET_OPENROUTER_API_KEY);
  }

  async setApiKey(key: string): Promise<void> {
    await this.secrets.store(SECRET_OPENROUTER_API_KEY, key);
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_OPENROUTER_API_KEY);
  }

  /** Prompts for and stores a key via a masked input box (pre-filled with the
   *  current key when there is one, so the user can confirm or replace it). Returns
   *  true if a key is stored, false if cancelled. */
  async promptForApiKey(prefill?: string): Promise<boolean> {
    const key = await vscode.window.showInputBox({
      title: 'OpenRouter API Key',
      prompt: 'Stored securely in your OS keychain — never in settings or logs.',
      password: true,
      ignoreFocusOut: true,
      value: prefill ?? '',
      placeHolder: 'sk-or-…',
      validateInput: (v) => (v.trim().length < 8 ? 'That does not look like a valid key.' : null)
    });
    if (!key) {
      return false;
    }
    await this.setApiKey(key.trim());
    return true;
  }
}
