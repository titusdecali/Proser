import { AiClient, AiMessage, ReadyState } from './AiClient';
import { readLines } from './streamUtil';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Cloud backend. Streams chat completions from OpenRouter, optionally
 *  preferring the Groq provider (with fallback). */
export class OpenRouterClient implements AiClient {
  constructor(
    private readonly model: string,
    private readonly apiKey: string | undefined,
    private readonly preferGroq: boolean
  ) {}

  get label(): string {
    return `OpenRouter · ${this.model}`;
  }

  async isReady(): Promise<ReadyState> {
    if (!this.apiKey) {
      return { ready: false, reason: 'No OpenRouter API key set.' };
    }
    return { ready: true };
  }

  async chat(
    messages: AiMessage[],
    onToken: (chunk: string) => void,
    signal?: AbortSignal
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error('No OpenRouter API key set.');
    }

    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true
    };
    if (this.preferGroq) {
      body.provider = { order: ['Groq'], allow_fallbacks: true };
    }

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/titusdecali/proser',
        'X-Title': 'Proser'
      },
      body: JSON.stringify(body),
      signal
    });

    if (!res.ok || !res.body) {
      const detail = await safeText(res);
      throw new Error(`OpenRouter ${res.status}: ${detail || res.statusText}`);
    }

    let full = '';
    for await (const line of readLines(res.body)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') {
        break;
      }
      try {
        const json = JSON.parse(payload);
        const delta: string | undefined = json.choices?.[0]?.delta?.content;
        if (delta) {
          full += delta;
          onToken(delta);
        }
      } catch {
        // Ignore keep-alive comments / partial frames.
      }
    }
    return full;
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
