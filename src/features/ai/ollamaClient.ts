import * as vscode from 'vscode';
import { AiClient, AiMessage, ReadyState } from './AiClient';
import { readLines } from './streamUtil';
import { fetchWithTimeout } from '../../util/fetchTimeout';

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
    signal?: AbortSignal
  ): Promise<string> {
    const res = await fetch(this.url('/api/chat'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, messages, stream: true }),
      signal
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama ${res.status}: ${res.statusText}`);
    }

    let full = '';
    for await (const line of readLines(res.body)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const json = JSON.parse(line);
        const piece: string | undefined = json.message?.content;
        if (piece) {
          full += piece;
          onToken(piece);
        }
        if (json.done) {
          break;
        }
      } catch {
        // Skip malformed frames.
      }
    }
    return full;
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
    const res = await fetch(this.url('/api/pull'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.model, stream: true }),
      signal
    });
    if (!res.ok || !res.body) {
      throw new Error(`Ollama pull ${res.status}: ${res.statusText}`);
    }
    for await (const line of readLines(res.body)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const json = JSON.parse(line);
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
      } catch (err) {
        if (err instanceof Error && err.message && !err.message.startsWith('Unexpected')) {
          throw err;
        }
      }
    }
  }
}
