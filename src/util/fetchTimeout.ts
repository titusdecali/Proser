/** fetch() with an abort-on-timeout guard, for SHORT requests (readiness
 *  probes, model lists). Streaming endpoints should use caller cancellation
 *  instead, since a blanket timeout would abort a legitimately long stream. */
export async function fetchWithTimeout(
  input: string,
  init: Parameters<typeof fetch>[1] = {},
  timeoutMs = 4000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
