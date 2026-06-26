import * as vscode from 'vscode';
import { SecretStore } from './secretStore';

/** The full "go to cloud" flow used by every Cloud (OpenRouter) entry point: first
 *  offer the API-key input (pre-filled with the current key so it can be confirmed
 *  or changed — the key powers Brainstorm/Revise), then the model-name input. Returns
 *  the chosen slug, or undefined if the user backs out of either step. */
export async function pickOpenRouterModelWithKey(
  secrets: SecretStore,
  current: string
): Promise<string | undefined> {
  const existing = await secrets.getApiKey();
  if (!(await secrets.promptForApiKey(existing ?? undefined))) {
    return undefined;
  }
  return pickOpenRouterModel(current);
}

const MODELS_URL = 'https://openrouter.ai/models';

/** Asks for the exact OpenRouter model name to use for Brainstorm & Revise. No
 *  curated list — the user types the slug from openrouter.ai/models directly, with a
 *  globe button that opens that page in the browser. An example placeholder shows the
 *  format; the current model is shown in the prompt for reference. Returns the trimmed
 *  slug, or undefined if cancelled. */
export function pickOpenRouterModel(current: string): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    const input = vscode.window.createInputBox();
    input.title = 'OpenRouter Model';
    input.prompt =
      'Enter the exact OpenRouter model name for Brainstorm & Revise. ' +
      `Click the globe to browse models.${current ? ` Current: ${current}.` : ''}`;
    input.placeholder = 'google/gemini-3.1-flash-lite';
    input.ignoreFocusOut = true;
    input.buttons = [
      { iconPath: new vscode.ThemeIcon('globe'), tooltip: 'Browse models on openrouter.ai' }
    ];

    let done = false;
    const finish = (value: string | undefined): void => {
      if (done) {
        return;
      }
      done = true;
      resolve(value);
      input.dispose();
    };

    input.onDidTriggerButton(() => void vscode.env.openExternal(vscode.Uri.parse(MODELS_URL)));
    input.onDidChangeValue(() => {
      input.validationMessage = undefined;
    });
    input.onDidAccept(() => {
      const v = input.value.trim();
      if (!v.includes('/')) {
        input.validationMessage = 'A model name looks like “vendor/model”, e.g. google/gemini-3.1-flash-lite.';
        return;
      }
      finish(v);
    });
    input.onDidHide(() => finish(undefined));
    input.show();
  });
}
