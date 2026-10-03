/** Minimal typed event emitter (no DOM EventTarget: payloads are reused objects, not Events). */
export class TypedEmitter<E extends Record<string, unknown>> {
  private readonly handlers: { [K in keyof E]?: Set<(payload: E[K]) => void> } = {};

  /**
   * Subscribes to an event.
   *
   * @returns An unsubscribe function.
   */
  on<K extends keyof E>(type: K, fn: (payload: E[K]) => void): () => void {
    const set = (this.handlers[type] ??= new Set());
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Emits synchronously to every subscriber. */
  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.handlers[type];
    if (!set) return;
    for (const fn of set) fn(payload);
  }

  /** Removes every subscriber. */
  clear(): void {
    for (const k of Object.keys(this.handlers) as (keyof E)[]) delete this.handlers[k];
  }
}
