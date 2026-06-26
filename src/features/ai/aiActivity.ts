import * as vscode from 'vscode';

/**
 * A tiny global bus for AI activity. Single-model design: Brainstorm, Revise,
 * Synonyms, Spell, and Story Memory all share ONE Ollama model, so two jobs hitting
 * it at once contend (and on a tight machine can spike memory). This bus does two
 * jobs:
 *  1. Drives the editor's footer "active model" indicator (spin while busy).
 *  2. Lets lightweight background features (synonyms, spell proofread) YIELD to a
 *     heavy foreground generation (Brainstorm chat, Revise, Story Memory build) via
 *     {@link isHeavyAiBusy}, so they don't queue behind — or steal memory from — it.
 */
export interface AiActivity {
  /** The model tag in play (matches the footer chip's tag). */
  tag: string;
  /** true = started, false = finished. */
  on: boolean;
  /** A long foreground generation that background lookups should yield to. */
  heavy: boolean;
}

const emitter = new vscode.EventEmitter<AiActivity>();
/** Fires whenever any AI operation starts or stops. */
export const onAiActivity = emitter.event;

let heavyCount = 0;

/** True while a heavy foreground generation (Brainstorm/Revise/Story Memory) runs.
 *  Background features consult this to skip AI and fall back to the dictionary /
 *  offline thesaurus until the model is free again. */
export function isHeavyAiBusy(): boolean {
  return heavyCount > 0;
}

/** Signal an AI op's start/stop. `heavy` marks a long foreground generation. */
export function signalAi(tag: string, on: boolean, heavy = false): void {
  if (heavy) {
    heavyCount = Math.max(0, heavyCount + (on ? 1 : -1));
  }
  emitter.fire({ tag, on, heavy });
}

/** Wrap an async AI op so its busy state is always signalled — even on throw. */
export async function withAi<T>(tag: string, heavy: boolean, fn: () => Promise<T>): Promise<T> {
  signalAi(tag, true, heavy);
  try {
    return await fn();
  } finally {
    signalAi(tag, false, heavy);
  }
}
