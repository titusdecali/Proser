/** Common shape for an AI backend (OpenRouter or Ollama). Higher-level
 *  features (revise, context synonyms) are built on top of `chat()` so prompt
 *  logic lives in one place rather than per backend. */

export interface AiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ReadyState {
  ready: boolean;
  /** Human-readable reason when not ready (shown to guide setup). */
  reason?: string;
  /** True when the backend exists but its model still needs to be pulled. */
  needsPull?: boolean;
}

export interface AiClient {
  /** Short label for progress/UX, e.g. "OpenRouter · meta-llama/llama-4-scout". */
  readonly label: string;

  /** Whether the backend is usable right now. */
  isReady(): Promise<ReadyState>;

  /**
   * Streams a chat completion. `onToken` is called with incremental text;
   * resolves with the full text. Honors an optional AbortSignal.
   */
  chat(messages: AiMessage[], onToken: (chunk: string) => void, signal?: AbortSignal): Promise<string>;
}
