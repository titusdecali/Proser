/**
 * One place for the host→webview message dispatch every webview bundle was
 * hand-rolling as a long `if (msg.type === …) … else if …` chain. Pass a map of
 * `type → handler`; unknown or malformed messages are ignored.
 *
 * The optional type parameter lets a caller constrain the keys to a known message
 * union (see protocol.ts) for editor hints, while staying permissive by default.
 */
export type MessageHandlers<T extends string = string> = Partial<
  Record<T, (msg: any) => void>
>;

/** Registers a single `window` 'message' listener that dispatches by `msg.type`.
 *  Call once at startup. */
export function onHostMessage<T extends string = string>(handlers: MessageHandlers<T>): void {
  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    handlers[msg.type as T]?.(msg);
  });
}
