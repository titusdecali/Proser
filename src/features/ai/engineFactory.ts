import * as vscode from 'vscode';
import { ConfigKeys, EXTENSION_ID } from '../../constants';
import { AiClient } from './AiClient';
import { OpenRouterClient } from './openRouterClient';
import { OllamaClient, unloadOtherModels } from './ollamaClient';
import { SecretStore } from './secretStore';
import { pickLocalModel } from './localModelPicker';
import { LOCAL_MODELS, detectMemoryProfile, editorFitsWithHelper, localModelInfo } from './ramAdvisor';
import { isHeavyAiBusy } from './aiActivity';

export type EngineKind = 'off' | 'openrouter' | 'ollama';

function config() {
  return vscode.workspace.getConfiguration(EXTENSION_ID);
}

/**
 * Builds a client for a feature (synonyms or spelling) on the SAME Ollama server
 * and model the editor uses. Single-model design: synonyms/spell reuse the one
 * resident editor model on the shared endpoint, so only ONE model is ever loaded
 * (no second `ollama serve`, no eviction/swap, no two-model OOM). Undefined when
 * no model is set (the feature then uses the dictionary / offline thesaurus).
 */
async function getFeatureEngine(model: string): Promise<OllamaClient | undefined> {
  if (!vscode.workspace.isTrusted || !model) {
    return undefined;
  }
  const shared = config().get<string>(ConfigKeys.aiOllamaEndpoint, 'http://localhost:11434');
  return new OllamaClient(shared, model);
}

/** The editor models that run stably on this machine, plus the currently-selected
 *  Ollama model pinned in (even if custom/over-tier). Single-model design: this one
 *  model serves everything, so the list is gated by its own footprint alone. Shared
 *  by Settings → AI Model and the Brainstorm model dropdown. */
export async function fittingEditorModels(): Promise<Array<{ tag: string; label: string }>> {
  let models: Array<{ tag: string; label: string }>;
  try {
    const profile = await detectMemoryProfile();
    models = LOCAL_MODELS.filter((m) => editorFitsWithHelper(m, profile, 0)).map((m) => ({
      tag: m.tag,
      label: m.label
    }));
  } catch {
    models = LOCAL_MODELS.map((m) => ({ tag: m.tag, label: m.label }));
  }
  const cfg = config();
  if (cfg.get<string>(ConfigKeys.aiEngine, 'off') === 'ollama') {
    const current = cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b');
    if (current && !models.some((m) => m.tag === current)) {
      models.unshift({ tag: current, label: localModelInfo(current)?.label ?? current });
    }
  }
  return models;
}

/** Client for synonym/antonym lookups (or undefined → dictionary / offline thesaurus).
 *  Single-model design: uses the one editor model. Returns undefined while a heavy
 *  foreground generation (Brainstorm/Revise/Story Memory) is running, so inline
 *  lookups fall back to the instant dictionary instead of queuing behind it. */
export async function getSynonymsEngine(): Promise<OllamaClient | undefined> {
  if (isHeavyAiBusy()) {
    return undefined; // yield the single model to the foreground generation
  }
  const model = await resolveSynonymsModel();
  return model ? getFeatureEngine(model) : undefined;
}

/** The model for synonym/antonym lookups. Single-model design: in Ollama mode this
 *  is the one editor model (already resident — no separate helper, no extra memory).
 *  Empty when the engine isn't local Ollama OR the user picked Online/Offline
 *  (`thesaurus.aiMode === 'local'`), so synonyms fall back to Datamuse/WordNet. */
async function resolveSynonymsModel(): Promise<string> {
  const cfg = config();
  if (cfg.get<EngineKind>(ConfigKeys.aiEngine, 'off') === 'off') {
    return '';
  }
  if (cfg.get<string>(ConfigKeys.thesaurusAiMode, 'ai') === 'local') {
    return ''; // user chose Datamuse / WordNet for synonyms
  }
  return cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b').trim();
}
/** Whether a model is strong enough to CLEAR dictionary false-positives (tell a
 *  real-but-unknown word / name / sound from a typo) and grade grammar — proven
 *  reliable only at ≈Gemma-E2B class. A tiny ~1B defaults to "intentional" for
 *  everything, so it's locked out of clearing. Matches the Gemma family (strong at
 *  this), any tag ≥ ~2B, or an E2B/E4B "effective" model. */
export function clearCapable(tag: string): boolean {
  if (!tag) {
    return false;
  }
  return /gemma/i.test(tag) || /:(?:[2-9]|[1-9]\d)b\b/i.test(tag) || /\be[24]b\b/i.test(tag);
}

/** The model the AI spell/proofread pass should ACTUALLY use. Single-model design:
 *  in Ollama mode (with AI spell left on, `ai.spellAi`) this is the one editor model
 *  (reused in place — no separate helper, no extra memory; see {@link getFeatureEngine}).
 *  Clearing/grammar stays gated by {@link clearCapable} downstream (a weak editor
 *  model still suggests corrections but won't clear). Empty when the engine isn't
 *  local Ollama OR the user turned AI spell off → Hunspell dictionary only. */
export function resolveSpellModel(): string {
  const cfg = config();
  if (cfg.get<EngineKind>(ConfigKeys.aiEngine, 'off') === 'off') {
    return '';
  }
  if (!cfg.get<boolean>(ConfigKeys.aiSpellAi, true)) {
    return ''; // user chose dictionary-only spelling
  }
  return cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b').trim();
}

/** The local model for the editor-side CHECK passes (tense). Independent of the
 *  Spell Check AI toggle and the thesaurus setting — these checks own their on/off
 *  switches (`checks.*`). Empty only when AI is off entirely. Always local: the
 *  cloud key stays reserved for Brainstorm/Revise. */
export function resolveLocalModel(): string {
  const cfg = config();
  if (cfg.get<EngineKind>(ConfigKeys.aiEngine, 'off') === 'off') {
    return '';
  }
  return cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b').trim();
}

/** Local engine for the check passes (tense), or undefined while a heavy
 *  foreground generation runs or AI is off. Unlike {@link getSpellEngine} this does
 *  NOT depend on `ai.spellAi`, so turning off AI grammar/spell never disables the
 *  checks. */
export function getCheckEngine(): Promise<OllamaClient | undefined> {
  if (isHeavyAiBusy()) {
    return Promise.resolve(undefined);
  }
  return getFeatureEngine(resolveLocalModel());
}

/** Client for AI spelling/proofread (or undefined → Hunspell only). Single-model
 *  design: uses the one editor model. Returns undefined while a heavy foreground
 *  generation (Brainstorm/Revise/Story Memory) is running, so the background
 *  proofread yields the model and stays dictionary-only until it's free again (the
 *  editor re-runs the pass when the generation finishes). */
export function getSpellEngine(): Promise<OllamaClient | undefined> {
  if (isHeavyAiBusy()) {
    return Promise.resolve(undefined);
  }
  return getFeatureEngine(resolveSpellModel());
}

/** Whether the spell/proofread pass can run. Single-model design: spell reuses the
 *  one local model already loaded for the other features (0 extra memory), so it
 *  fits whenever that model itself does — including in cloud-editor mode, where
 *  Brainstorm/Revise run remotely but spell still uses the local Ollama model. */
export async function proofreadFits(): Promise<boolean> {
  const cfg = config();
  if (cfg.get<EngineKind>(ConfigKeys.aiEngine, 'off') === 'off') {
    return true;
  }
  const editorTag = cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b');
  try {
    const profile = await detectMemoryProfile();
    const editor = localModelInfo(editorTag) ?? {
      tag: editorTag,
      label: editorTag,
      sizeGb: 8,
      minRamGb: 16,
      note: ''
    };
    return editorFitsWithHelper(editor, profile, 0);
  } catch {
    return true; // memory detection failed — don't block the feature
  }
}

/** Address of a previous build's dedicated AI-helper Ollama server. We no longer
 *  run it, but a leftover one can still hold a model resident — free it too. */
const LEGACY_HELPER_ENDPOINT = 'http://127.0.0.1:11435';

/**
 * Enforces the single-model invariant in memory: keeps ONLY the configured editor
 * model resident on the local Ollama and unloads everything else (plus anything on a
 * previous build's helper server). Single-model design — call on activation and on
 * every model/engine change so a stray model can't sit beside ours and OOM the
 * machine. No-op for cloud/off engines or a remote endpoint (nothing local to manage).
 */
export async function enforceSingleLoadedModel(): Promise<void> {
  const cfg = config();
  if (cfg.get<EngineKind>(ConfigKeys.aiEngine, 'off') === 'off') {
    return;
  }
  const endpoint = cfg.get<string>(ConfigKeys.aiOllamaEndpoint, 'http://localhost:11434');
  const keep = cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b').trim();
  await unloadOtherModels(endpoint, keep);
  // Free any model left resident by a previous build's dedicated helper server
  // (only meaningful when the editor model runs on the standard local Ollama).
  if (isLocalOllama(endpoint)) {
    await unloadOtherModels(LEGACY_HELPER_ENDPOINT, '');
  }
}

/** True for the standard local Ollama endpoint (so we don't poke a remote server's
 *  loopback or a custom port when freeing the legacy helper). */
function isLocalOllama(endpoint: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1):11434(\/|$)/i.test(endpoint.replace(/\/$/, '') + '/');
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

/** Engine for the NON-editor AI features — the manuscript Checks (tense/passive/
 *  continuity), Story Memory, and issue Fix-suggestions. These ALWAYS run on the
 *  LOCAL Ollama model; the OpenRouter key is reserved for Brainstorm/Revise. Silent
 *  (never prompts for setup). Identical to {@link createEngine} in off/ollama modes
 *  — only in cloud (openrouter) mode does it diverge, returning the local model
 *  instead of the cloud client. Undefined when AI is off (or untrusted / no model). */
export async function createFeatureEngine(): Promise<OllamaClient | undefined> {
  if (config().get<EngineKind>(ConfigKeys.aiEngine, 'off') === 'off') {
    return undefined;
  }
  return getFeatureEngine(config().get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b').trim());
}

/** Interactive variant of {@link createFeatureEngine}: in off/ollama modes it guides
 *  the user through setup via {@link prepareEngine} (choose engine / start Ollama /
 *  pull model); in cloud mode it silently uses the local model — we never push the
 *  user into local setup when they deliberately chose the cloud editor. */
export async function prepareFeatureEngine(secrets: SecretStore): Promise<AiClient | undefined> {
  if (config().get<EngineKind>(ConfigKeys.aiEngine, 'off') === 'openrouter') {
    return getFeatureEngine(config().get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b').trim());
  }
  return prepareEngine(secrets);
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

/**
 * Makes sure `model` is downloaded on the local Ollama (prompting + pulling if
 * needed) so it's ready to load. Used after a model is chosen from the inline
 * Settings dropdown.
 */
export async function ensureModelPulled(model: string, label = 'model'): Promise<void> {
  if (!model) {
    return;
  }
  const endpoint = config().get<string>(ConfigKeys.aiOllamaEndpoint, 'http://localhost:11434');
  const client = new OllamaClient(endpoint, model);
  const state = await client.isReady();
  if (state.ready) {
    vscode.window.setStatusBarMessage(`$(sparkle) Proser: ${label} model set to ${model}.`, 4000);
    return;
  }
  if (!state.needsPull) {
    vscode.window.showWarningMessage(
      `${state.reason ?? 'Ollama is not available.'} Start Ollama, then re-select the model.`
    );
    return;
  }
  const pull = await vscode.window.showInformationMessage(
    `Download the ${label} model “${model}”? (one time)`,
    'Pull',
    'Cancel'
  );
  if (pull !== 'Pull') {
    return;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Pulling ${model}…`, cancellable: true },
      async (progress, token) => {
        const controller = new AbortController();
        token.onCancellationRequested(() => controller.abort());
        await client.pull(progress, controller.signal);
      }
    );
    vscode.window.setStatusBarMessage(`$(sparkle) Proser: ${label} ready — ${model}.`, 4000);
  } catch (err) {
    if (!isAbort(err)) {
      vscode.window.showErrorMessage(`Could not pull model: ${describe(err)}`);
    }
  }
}

/** A model shown in the editor's AI status indicator (bottom-right of the frame). */
export interface AiChip {
  /** Ollama/OpenRouter model tag, or '' for the dictionary entry. */
  tag: string;
  label: string;
  /** Which features this model serves: 'write' (Brainstorm/Revise), 'spell', 'synonyms'. */
  roles: Array<'write' | 'spell' | 'synonyms'>;
  kind: 'ai' | 'dictionary';
}

function shortModelLabel(tag: string): string {
  return tag.includes('/') ? tag.slice(tag.lastIndexOf('/') + 1) : tag;
}

/** The AI models currently in play, deduped by tag, for the editor's status
 *  indicator: the writer (editor) model, the synonyms helper, and the RESOLVED
 *  spell model — plus a 'dictionary' entry when no capable model clears spelling,
 *  so the user can see at a glance whether AI proofread is actually active. */
export async function aiStatusChips(): Promise<AiChip[]> {
  const cfg = config();
  const chips: AiChip[] = [];
  const byTag = new Map<string, AiChip>();
  const add = (tag: string, role: 'write' | 'spell' | 'synonyms'): void => {
    if (!tag) {
      return;
    }
    let c = byTag.get(tag);
    if (!c) {
      c = { tag, label: shortModelLabel(tag), roles: [], kind: 'ai' };
      byTag.set(tag, c);
      chips.push(c);
    }
    if (!c.roles.includes(role)) {
      c.roles.push(role);
    }
  };

  const engine = cfg.get<EngineKind>(ConfigKeys.aiEngine, 'off');
  if (engine === 'openrouter') {
    add(cfg.get<string>(ConfigKeys.aiOpenRouterModel, 'meta-llama/llama-4-scout'), 'write');
  } else if (engine === 'ollama') {
    add(cfg.get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b'), 'write');
  }

  add(await resolveSynonymsModel(), 'synonyms');

  // Spell clearing only runs on a capable model that fits beside the editor;
  // otherwise it's dictionary-only — surface that explicitly.
  const spell = resolveSpellModel();
  if (spell && clearCapable(spell) && (await proofreadFits())) {
    add(spell, 'spell');
  } else {
    chips.push({ tag: '', label: 'Dictionary', roles: ['spell'], kind: 'dictionary' });
  }
  return chips;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Whether an error looks like an Ollama out-of-memory / can't-allocate failure
 *  (or our chat stall watchdog firing), so callers can show a tailored
 *  "your machine ran out of memory — try a smaller model" message. */
export function isMemoryError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /more system memory|out of memory|\boom\b|requires more .*memory|cannot allocate|insufficient memory|not enough memory|stopped responding/i.test(
    msg
  );
}
