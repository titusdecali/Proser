/** A trailing-edge debounce keyed by an arbitrary string, so independent
 *  documents can be debounced separately through one helper. The delay may be
 *  a function, which is evaluated at schedule time so config changes take
 *  effect without rebuilding the debouncer. */
export function createKeyedDebouncer(delay: number | (() => number)) {
  const timers = new Map<string, NodeJS.Timeout>();

  function schedule(key: string, fn: () => void): void {
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    const delayMs = typeof delay === 'function' ? delay() : delay;
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        fn();
      }, delayMs)
    );
  }

  function cancel(key: string): void {
    const existing = timers.get(key);
    if (existing) {
      clearTimeout(existing);
      timers.delete(key);
    }
  }

  function dispose(): void {
    for (const timer of timers.values()) {
      clearTimeout(timer);
    }
    timers.clear();
  }

  return { schedule, cancel, dispose };
}
