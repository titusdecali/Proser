import { AiClient, AiMessage, ChatOpts, ReadyState } from './AiClient';
import { consumeStream, STREAM_DONE } from './streamUtil';

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** One SSE `data:` frame from OpenRouter's chat-completions stream. */
interface OpenRouterFrame {
  choices?: Array<{ delta?: { content?: string } }>;
}

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
    signal?: AbortSignal,
    opts?: ChatOpts
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
    if (opts?.format === 'json') {
      body.response_format = { type: 'json_object' }; // constrained JSON output
    } else if (opts?.format && typeof opts.format === 'object') {
      body.response_format = {
        type: 'json_schema',
        json_schema: { name: 'extraction', strict: true, schema: opts.format }
      };
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

    return consumeStream<OpenRouterFrame>(res.body, onToken, {
      framePayload: (line) => {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) {
          return null; // SSE comment / keep-alive
        }
        const payload = trimmed.slice(5).trim();
        return payload === '[DONE]' ? STREAM_DONE : payload;
      },
      extractDelta: (f) => f.choices?.[0]?.delta?.content
    });
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}
