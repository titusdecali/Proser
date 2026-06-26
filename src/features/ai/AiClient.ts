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

/** Per-call options. `format` requests constrained decoding:
 *  - `'json'` → any grammatically-valid JSON object.
 *  - a JSON Schema object → output forced to that exact shape (all required
 *    fields present). Essential for reliable extraction: unconstrained, models
 *    occasionally emit invalid JSON OR omit whole fields (synopsis-only) on
 *    dense chapters — the schema fixes both. */
export interface ChatOpts {
  format?: 'json' | Record<string, unknown>;
  /** Context window (tokens) for the request. Ollama otherwise defaults to ~2k
   *  and silently truncates the input — set this so the model sees the whole
   *  chapter / injected canon. */
  numCtx?: number;
  /** Disable a thinking/reasoning model's chain-of-thought for this call. The
   *  user's local gemma4 models are thinking models; Ollama routes their reasoning
   *  into a separate field and leaves `content` empty until it finishes, so on a
   *  structured (schema) call they reason past the budget and return nothing. Set
   *  `false` for extraction / spell / synonyms so the model answers directly and
   *  fast. Undefined = leave the model's default. (No-op for OpenRouter.) */
  think?: boolean;
  /** Cap on generated tokens (Ollama `num_predict`) — defense against runaway
   *  grammar-constrained decoding. Undefined = no cap. */
  numPredict?: number;
  /** Sampling temperature. The user's gemma4 models default to 1 (creative) — far
   *  too high for deterministic extraction/spell, which should pin this low (~0.2)
   *  for fidelity + consistency. Undefined = leave the model's default. */
  temperature?: number;
}

export interface AiClient {
  /** Short label for progress/UX, e.g. "OpenRouter · meta-llama/llama-4-scout". */
  readonly label: string;

  /** Whether the backend is usable right now. */
  isReady(): Promise<ReadyState>;

  /**
   * Streams a chat completion. `onToken` is called with incremental text;
   * resolves with the full text. Honors an optional AbortSignal and per-call opts.
   */
  chat(
    messages: AiMessage[],
    onToken: (chunk: string) => void,
    signal?: AbortSignal,
    opts?: ChatOpts
  ): Promise<string>;
}
