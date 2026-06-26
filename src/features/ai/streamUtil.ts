/** Yields complete text lines from a fetch Response body as bytes arrive.
 *  Handles chunk boundaries that split a line. */
export async function* readLines(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        yield buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Sentinel a `framePayload` returns to stop the stream (e.g. SSE `[DONE]`). */
export const STREAM_DONE: unique symbol = Symbol('stream-done');

/** What `framePayload` may return for one raw line: a JSON string to parse, `null`
 *  to skip the line (blank / keep-alive / non-data), or STREAM_DONE to stop. */
export type FramePayload = string | null | typeof STREAM_DONE;

/** Per-provider hooks for {@link consumeStream}. Lets Ollama (NDJSON) and
 *  OpenRouter (SSE) share one streaming loop while keeping their own framing. */
export interface StreamSpec<T> {
  /** Called once per received line, before parsing — e.g. to re-arm a watchdog. */
  onLine?: () => void;
  /** Map a raw line to a payload to parse, `null` to skip, or STREAM_DONE to stop. */
  framePayload(line: string): FramePayload;
  /** Pull the incremental text out of a parsed frame (or undefined for none). */
  extractDelta(frame: T): string | undefined;
  /** Optional: inspect a frame after its delta is emitted. Throw to fail the
   *  stream (e.g. an error frame); return `true` to stop cleanly (e.g. `done`). */
  inspectFrame?(frame: T): boolean | void;
}

/**
 * Drives a streaming chat response: reads lines, parses each frame, emits its
 * delta via `onToken`, and returns the accumulated text. Malformed/partial
 * frames are skipped. The provider-specific framing lives entirely in `spec`.
 */
export async function consumeStream<T>(
  body: ReadableStream<Uint8Array>,
  onToken: (chunk: string) => void,
  spec: StreamSpec<T>
): Promise<string> {
  let full = '';
  for await (const line of readLines(body)) {
    spec.onLine?.();
    const payload = spec.framePayload(line);
    if (payload === null) {
      continue;
    }
    if (payload === STREAM_DONE) {
      break;
    }
    let frame: T;
    try {
      frame = JSON.parse(payload) as T;
    } catch {
      continue; // keep-alive comment / partial frame
    }
    const delta = spec.extractDelta(frame);
    if (delta) {
      full += delta;
      onToken(delta);
    }
    if (spec.inspectFrame?.(frame)) {
      break;
    }
  }
  return full;
}
