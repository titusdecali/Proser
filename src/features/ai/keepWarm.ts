import * as vscode from 'vscode';
import { EXTENSION_ID, ConfigKeys, MARKDOWN_LANGUAGE_ID } from '../../constants';
import { warmModel, EngineKind } from './engineFactory';

/** At most this often, typing re-arms the model's keep-alive. Far shorter than the
 *  shortest keep-alive preset (5 min), so the model never idle-unloads while you're
 *  actively typing — yet we touch Ollama at most once per interval instead of on
 *  every keystroke. */
const TOUCH_THROTTLE_MS = 60_000;

/**
 * Keeps the local model loaded while you type. Ollama re-arms keep_alive on every
 * request, but the live AI passes (spell/tense/passive/grammar) only fire when their
 * checks are enabled — so on plain typing, or with those checks off, the model could
 * still idle-unload mid-session. This ties a throttled keep-alive touch directly to
 * editing activity, so ANY typing holds the model resident regardless of whether that
 * keystroke made a request. No-op unless the local Ollama engine is active.
 */
export function registerKeepModelWarm(context: vscode.ExtensionContext): void {
  let lastTouch = 0;
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.languageId !== MARKDOWN_LANGUAGE_ID || e.contentChanges.length === 0) {
        return; // only real edits to a manuscript document
      }
      if (vscode.workspace.getConfiguration(EXTENSION_ID).get<EngineKind>(ConfigKeys.aiEngine, 'off') !== 'ollama') {
        return; // cloud/off — no resident local model to keep warm
      }
      const now = Date.now();
      if (now - lastTouch < TOUCH_THROTTLE_MS) {
        return; // already re-armed recently; don't spam Ollama per keystroke
      }
      lastTouch = now;
      void warmModel(); // fire-and-forget; re-arms keep_alive to the configured window
    })
  );
}
