import * as vscode from 'vscode';
import { AiClient, AiMessage, ChatOpts, ReadyState } from './AiClient';
import { consumeStream, readLines } from './streamUtil';
import { fetchWithTimeout } from '../../util/fetchTimeout';
import { AI_KEEP_ALIVE } from '../../constants';

/** If Ollama sends no data for this long during a chat, treat it as stalled and
 *  abort. Covers a cold model load (a large model can take ~30–120s to page into
 *  memory) plus inter-token gaps; a longer silence means it died or ran out of
 *  memory, so we surface an error instead of spinning forever. */
const CHAT_STALL_MS = 90_000;

/** Like CHAT_STALL_MS but for a model pull: a download streams frequent progress
 *  frames, so this long a silence (no bytes, no progress) means the pull died or the
 *  network dropped. Re-armed on every frame, so a slow-but-alive download is fine. */
const PULL_STALL_MS = 120_000;

interface StallGuard {
  /** Signal to pass to fetch — aborts on caller cancellation OR a stall. */
  readonly signal: AbortSignal;
  /** True when the guard aborted because of a stall (vs. caller cancellation). */
  readonly stalled: boolean;
  /** (Re)arm the watchdog. Call before connecting and on every received frame. */
  arm(): void;
  /** Clear the timer and detach the caller-signal listener. Call in `finally`. */
  dispose(): void;
}

/** Combines a caller's AbortSignal with an internal stall watchdog so a stream that
 *  goes silent (e.g. an out-of-memory model load, or a dropped download) surfaces an
 *  error instead of hanging the UI forever. Shared by chat() and pull(). */
function createStallGuard(stallMs: number, signal?: AbortSignal): StallGuard {
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  if (signal) {
    if (signal.aborted) {
      ctrl.abort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    signal: ctrl.signal,
    get stalled(): boolean {
      return stalled;
    },
    arm(): void {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        stalled = true;
        ctrl.abort();
      }, stallMs);
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    }
  };
}

/** Pulls a human-readable error out of a non-OK response (Ollama returns
 *  `{"error":"…"}`), falling back to the status text. */
async function responseError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: unknown };
      if (typeof j.error === 'string' && j.error) {
        return j.error;
      }
    } catch {
      /* body wasn't JSON */
    }
    return text || res.statusText;
  } catch {
    return res.statusText;
  }
}

/** One NDJSON frame from Ollama's `/api/chat` stream. */
interface OllamaChatFrame {
  message?: { content?: string };
  done?: boolean;
  error?: unknown;
}

/** Local backend. Talks to a user-run Ollama server over its REST API. */
export class OllamaClient implements AiClient {
  constructor(
    private readonly endpoint: string,
    private readonly model: string
  ) {}

  get label(): string {
    return `Ollama · ${this.model}`;
  }

  private url(path: string): string {
    return `${this.endpoint.replace(/\/$/, '')}${path}`;
  }

  async isReady(): Promise<ReadyState> {
    let tags: string[];
    try {
      const res = await fetchWithTimeout(this.url('/api/tags'));
      if (!res.ok) {
        return { ready: false, reason: `Ollama responded ${res.status}.` };
      }
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      tags = (data.models ?? []).map((m) => m.name);
    } catch {
      return { ready: false, reason: 'Ollama is not running at ' + this.endpoint };
    }
    const has = tags.some((t) => t === this.model || t.startsWith(this.model + ':'));
    if (!has) {
      return { ready: false, needsPull: true, reason: `Model “${this.model}” is not pulled.` };
    }
    return { ready: true };
  }

  async chat(
    messages: AiMessage[],
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
    opts?: ChatOpts
  ): Promise<string> {
    // keep_alive keeps the model resident between requests (Ollama's default is only
    // 5 min, so it idle-unloads mid-writing). Each request refreshes the window.
    const body: Record<string, unknown> = { model: this.model, messages, stream: true, keep_alive: AI_KEEP_ALIVE };
    if (opts?.format) {
      // Ollama accepts both 'json' and a full JSON Schema object as `format`.
      body.format = opts.format;
    }
    if (opts?.think !== undefined) {
      // Thinking models (e.g. gemma4) otherwise reason into a separate field and
      // leave `content` empty until done — fatal for structured extraction.
      body.think = opts.think;
    }
    const options: Record<string, unknown> = {};
    if (opts?.numCtx) {
      // Without this Ollama uses a ~2k default and truncates the input.
      options.num_ctx = opts.numCtx;
    }
    if (opts?.numPredict) {
      options.num_predict = opts.numPredict;
    }
    if (opts?.temperature !== undefined) {
      options.temperature = opts.temperature;
    }
    if (Object.keys(options).length) {
      body.options = options;
    }

    // Combine the caller's cancellation with an internal stall watchdog so a
    // model that never loads (e.g. out of memory) surfaces an error instead of
    // hanging the Brainstorm/scan UI forever. The watchdog is re-armed on every
    // frame, so a legitimately long stream is never cut off mid-flight.
    const guard = createStallGuard(CHAT_STALL_MS, signal);

    try {
      guard.arm(); // guards the connect + initial model load, before any frame arrives
      const res = await fetch(this.url('/api/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: guard.signal
      });
      if (!res.ok || !res.body) {
        throw new Error(`Ollama ${res.status}: ${await responseError(res)}`);
      }

      return await consumeStream<OllamaChatFrame>(res.body, onToken, {
        onLine: () => guard.arm(), // data arrived — reset the watchdog
        framePayload: (line) => (line.trim() ? line : null),
        extractDelta: (f) => f.message?.content,
        inspectFrame: (f) => {
          // Ollama streams failures (e.g. "model requires more system memory…") as
          // an `error` frame; without this the loop ignored it and waited forever.
          if (f.error) {
            throw new Error(String(f.error));
          }
          return f.done === true;
        }
      });
    } catch (err) {
      if (guard.stalled) {
        throw new Error(
          `Ollama stopped responding while loading or running “${this.model}” ` +
            `(no output for ${Math.round(CHAT_STALL_MS / 1000)}s). It may be out of ` +
            `memory — try a smaller model.`
        );
      }
      throw err;
    } finally {
      guard.dispose();
    }
  }

  /** The model's max context window in tokens (from /api/show → model_info's
   *  `<arch>.context_length`), or undefined if it can't be determined. */
  async contextLength(): Promise<number | undefined> {
    try {
      const res = await fetch(this.url('/api/show'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.model })
      });
      if (!res.ok) {
        return undefined;
      }
      const data = (await res.json()) as { model_info?: Record<string, unknown> };
      for (const [k, v] of Object.entries(data.model_info ?? {})) {
        if (k.endsWith('.context_length') && typeof v === 'number') {
          return v;
        }
      }
    } catch {
      /* offline / unsupported — caller falls back to a default */
    }
    return undefined;
  }

  /** Pulls the model, reporting progress. Resolves when complete. Honors an
   *  optional AbortSignal so a cancellable progress can stop the pull. */
  async pull(
    progress: vscode.Progress<{ message?: string }>,
    signal?: AbortSignal
  ): Promise<void> {
    const guard = createStallGuard(PULL_STALL_MS, signal);
    try {
      guard.arm(); // guards the connect + manifest fetch, before any frame arrives
      const res = await fetch(this.url('/api/pull'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: this.model, stream: true }),
        signal: guard.signal
      });
      if (!res.ok || !res.body) {
        throw new Error(`Ollama pull ${res.status}: ${res.statusText}`);
      }
      for await (const line of readLines(res.body)) {
        guard.arm(); // progress arrived — reset the watchdog
        if (!line.trim()) {
          continue;
        }
        let json: { error?: unknown; status?: unknown; completed?: number; total?: number };
        try {
          json = JSON.parse(line);
        } catch {
          continue; // skip malformed/partial frames
        }
        // Ollama streams failures (e.g. "pull model manifest: …") as an error frame.
        if (json.error) {
          throw new Error(String(json.error));
        }
        if (json.status) {
          let msg = String(json.status);
          if (json.completed && json.total) {
            const pct = Math.floor((json.completed / json.total) * 100);
            msg += ` (${pct}%)`;
          }
          progress.report({ message: msg });
        }
      }
    } catch (err) {
      if (guard.stalled) {
        throw new Error(
          `Ollama stopped responding while downloading “${this.model}” ` +
            `(no progress for ${Math.round(PULL_STALL_MS / 1000)}s). Check your ` +
            `connection and try again.`
        );
      }
      throw err;
    } finally {
      guard.dispose();
    }
  }
}

/** Normalizes an Ollama model name for comparison (drops a trailing `:latest`). */
function sameModel(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/:latest$/i, '');
  return !!a && !!b && norm(a) === norm(b);
}

/**
 * Frees memory so only ONE model is resident: asks Ollama which models are loaded
 * (`/api/ps`) and unloads every one whose tag isn't `keepTag` (an empty `keepTag`
 * unloads them all). Unloading uses `keep_alive: 0`, Ollama's documented way to
 * evict a model immediately. Best-effort and silent — if Ollama isn't running there's
 * nothing resident to free. Single-model design: called on activation and whenever
 * the model changes, so a model left loaded by another app (or a previous build's
 * helper server) can't sit beside Proser's model and trigger an out-of-memory crash.
 */
export async function unloadOtherModels(endpoint: string, keepTag: string): Promise<void> {
  const base = endpoint.replace(/\/$/, '');
  let loaded: string[];
  try {
    const res = await fetchWithTimeout(`${base}/api/ps`, {}, 2000);
    if (!res.ok) {
      return;
    }
    const data = (await res.json()) as { models?: Array<{ name?: string; model?: string }> };
    loaded = (data.models ?? []).map((m) => m.name || m.model || '').filter(Boolean);
  } catch {
    return; // Ollama unreachable → nothing resident to unload
  }
  await Promise.all(
    loaded
      .filter((name) => !sameModel(name, keepTag))
      .map((name) =>
        fetchWithTimeout(
          `${base}/api/generate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: name, keep_alive: 0 })
          },
          5000
        ).catch(() => undefined)
      )
  );
}
