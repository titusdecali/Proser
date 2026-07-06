import * as os from 'os';
import { execFile } from 'child_process';
import * as vscode from 'vscode';
import { ConfigKeys, EXTENSION_ID } from '../../constants';
import { fetchWithTimeout } from '../../util/fetchTimeout';
import { onAiActivity } from './aiActivity';

/**
 * Live load-state + memory readout for the single AI model, shown in the editor
 * footer beside the model chip. Polls Ollama's `/api/ps` (which lists resident
 * models and each one's GPU/unified-memory footprint) and broadcasts changes, plus
 * re-checks instantly whenever AI work starts/stops so "Loading Model…" appears the
 * moment a cold model begins loading and flips to "Model Ready" once it's resident.
 *
 * Ollama's `/api/ps` reports only the model's *loaded weight* footprint (for
 * `gemma4:e4b` that's ~3 GB — the "effective" active submodel), which badly
 * undercounts what the OS actually gives the `llama-server` runner (the full
 * mmapped weights + KV cache + Metal buffers, ~10 GB in Activity Monitor). So we
 * ALSO read the runner process's real resident memory (RSS) via `ps` and surface
 * both: the model-weight number from Ollama plus the true process RAM.
 */
export type ModelStatus = 'off' | 'idle' | 'loading' | 'ready';

export interface ModelState {
  status: ModelStatus;
  /** Short model name for display ('' when AI is off). */
  label: string;
  /** Ollama-reported loaded-weight footprint of the model(s), in GB (0 when none). */
  vramGb: number;
  /** Real RSS of the local `llama-server`/runner process(es), in GB. `undefined`
   *  when it can't be read (remote endpoint, Windows, or no runner found) — the
   *  footer then shows just {@link vramGb}. */
  ramGb?: number;
}

const GB = 1024 * 1024 * 1024;
const POLL_MS = 4000;

const emitter = new vscode.EventEmitter<ModelState>();
/** Fires when the model's load state or memory footprint changes. */
export const onModelState = emitter.event;

let last: ModelState = { status: 'off', label: '', vramGb: 0 };
/** The most recent state (so a newly-opened editor can render immediately). */
export function currentModelState(): ModelState {
  return last;
}

/** Count of in-flight AI ops (from the activity bus) — used to tell a cold model
 *  load ("loading") from an idle, unloaded model. */
let busyCount = 0;

function cfg() {
  return vscode.workspace.getConfiguration(EXTENSION_ID);
}
function shortLabel(tag: string): string {
  return tag.includes('/') ? tag.slice(tag.lastIndexOf('/') + 1) : tag;
}
function normModel(s: string): string {
  return (s || '').trim().replace(/:latest$/i, '');
}

/** True when `endpoint` points at this machine, so its runner process is one we
 *  can actually inspect with `ps` (a remote Ollama can't be). */
function isLocalEndpoint(endpoint: string): boolean {
  let host = '';
  try {
    host = new URL(endpoint).hostname;
  } catch {
    return false;
  }
  return host === '' || host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0';
}

/** Matches an Ollama inference runner's command line — the standalone
 *  `llama-server`/`llama_server` binary (macOS app bundle, older Linux) or the
 *  newer `ollama runner` subprocess — while NOT matching the tiny `ollama serve`
 *  parent (it has neither token). */
const RUNNER_RE = /llama[-_]server|\bollama\b.*\brunner\b/i;

/**
 * Real resident memory (RSS, in GB) of the local Ollama runner process(es) — the
 * number that actually shows up next to `llama-server` in Activity Monitor, which
 * Ollama's `/api/ps` badly undercounts. Reads `ps` on macOS/Linux; resolves
 * `undefined` for a remote endpoint, on Windows, or if no runner is found (the
 * caller then falls back to the Ollama weight number).
 *
 * Caveat: `ps rss` approximates Activity Monitor's "Memory" (phys_footprint) — the
 * same ballpark, but not identical, since macOS counts compressed/wired/GPU memory
 * differently. Still far closer than Ollama's ~3 GB estimate.
 */
function readModelRssGb(endpoint: string): Promise<number | undefined> {
  return new Promise((resolve) => {
    if (!isLocalEndpoint(endpoint) || (os.platform() !== 'darwin' && os.platform() !== 'linux')) {
      resolve(undefined);
      return;
    }
    try {
      execFile('ps', ['-Ao', 'rss=,command='], { timeout: 2000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
        if (err || !stdout) {
          resolve(undefined);
          return;
        }
        let rssKb = 0;
        let matched = false;
        for (const line of stdout.split(/\r?\n/)) {
          const m = /^\s*(\d+)\s+(.*)$/.exec(line);
          if (!m || !RUNNER_RE.test(m[2])) {
            continue;
          }
          rssKb += parseInt(m[1], 10);
          matched = true;
        }
        resolve(matched ? Math.round((rssKb * 1024) / GB * 10) / 10 : undefined);
      });
    } catch {
      resolve(undefined);
    }
  });
}

async function poll(): Promise<void> {
  let next: ModelState;
  if (cfg().get<string>(ConfigKeys.aiEngine, 'off') !== 'ollama') {
    next = { status: 'off', label: '', vramGb: 0 }; // cloud/off → no local model to report
  } else {
    const endpoint = cfg()
      .get<string>(ConfigKeys.aiOllamaEndpoint, 'http://localhost:11434')
      .replace(/\/$/, '');
    const model = cfg().get<string>(ConfigKeys.aiOllamaModel, 'gemma4:e4b').trim();
    const label = shortLabel(model);
    try {
      const res = await fetchWithTimeout(`${endpoint}/api/ps`, {}, 1500);
      if (!res.ok) {
        throw new Error(`ps ${res.status}`);
      }
      const data = (await res.json()) as {
        models?: Array<{ name?: string; model?: string; size_vram?: number; size?: number }>;
      };
      const models = data.models ?? [];
      const resident = models.some((m) => normModel(m.name || m.model || '') === normModel(model));
      const vramBytes = models.reduce((sum, m) => sum + (m.size_vram ?? m.size ?? 0), 0);
      const vramGb = Math.round((vramBytes / GB) * 10) / 10;
      const status: ModelStatus = resident ? 'ready' : busyCount > 0 ? 'loading' : 'idle';
      // Real process RAM, but only when there's actually a runner loaded to read.
      const ramGb = models.length ? await readModelRssGb(endpoint) : undefined;
      next = { status, label, vramGb, ramGb };
    } catch {
      // Ollama unreachable: a request in flight means it's spinning up, else it's off.
      next = { status: busyCount > 0 ? 'loading' : 'off', label, vramGb: 0 };
    }
  }
  if (
    next.status !== last.status ||
    next.label !== last.label ||
    next.vramGb !== last.vramGb ||
    next.ramGb !== last.ramGb
  ) {
    last = next;
    emitter.fire(next);
  }
}

/** Starts the background poll + instant refresh on AI activity / model change, and
 *  broadcasts via {@link onModelState}. Call once at activation. */
export function startModelStatePolling(context: vscode.ExtensionContext): void {
  const tick = (): void => void poll();
  const timer = setInterval(tick, POLL_MS);
  context.subscriptions.push(
    { dispose: () => clearInterval(timer) },
    emitter,
    onAiActivity((ev) => {
      busyCount = Math.max(0, busyCount + (ev.on ? 1 : -1));
      tick(); // a request just started/ended — refresh the load state now
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiEngine}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiOllamaModel}`) ||
        e.affectsConfiguration(`${EXTENSION_ID}.${ConfigKeys.aiOllamaEndpoint}`)
      ) {
        tick();
      }
    })
  );
  tick(); // initial reading
}
