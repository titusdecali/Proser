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
 */
export type ModelStatus = 'off' | 'idle' | 'loading' | 'ready';

export interface ModelState {
  status: ModelStatus;
  /** Short model name for display ('' when AI is off). */
  label: string;
  /** Resident GPU/unified memory of the loaded model(s), in GB (0 when none). */
  vramGb: number;
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
      next = { status, label, vramGb };
    } catch {
      // Ollama unreachable: a request in flight means it's spinning up, else it's off.
      next = { status: busyCount > 0 ? 'loading' : 'off', label, vramGb: 0 };
    }
  }
  if (next.status !== last.status || next.label !== last.label || next.vramGb !== last.vramGb) {
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
