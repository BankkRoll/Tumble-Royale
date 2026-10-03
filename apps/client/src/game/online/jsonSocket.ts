/**
 * A reconnecting JSON WebSocket for the API realtime gateway and the
 * matchmaker status stream. Each (re)connect asks for a fresh URL (access
 * tokens expire after 15 minutes), backs off up to 10 s, and dispatches
 * messages by their `type` field.
 */

/** A message with a `type` discriminant. */
export interface TypedMessage {
  type: string;
  [key: string]: unknown;
}

/** Options for {@link JsonSocket}. */
export interface JsonSocketOptions {
  /** Builds the URL for each attempt (null = not signed in; retried later). */
  url: () => Promise<string | null>;
  /** Keep-alive message sent every 25 s (API gateway: `{ type: 'ping' }`). */
  ping?: TypedMessage;
  /** Log label. */
  label: string;
}

/**
 * Reconnecting socket.
 *
 * @example
 * const rt = new JsonSocket({ url: async () => api.wsUrl(await api.accessToken()), label: 'api' });
 * rt.on('party_update', (m) => …);
 * rt.start();
 */
export class JsonSocket {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, Set<(m: TypedMessage) => void>>();
  private readonly anyHandlers = new Set<(m: TypedMessage) => void>();
  private stopped = true;
  private attempts = 0;
  private retryTimer = 0;
  private pingTimer = 0;
  /** True while the socket is open. */
  connected = false;

  constructor(private readonly opts: JsonSocketOptions) {}

  /**
   * Subscribes to one message type (`*` = every message).
   *
   * @returns Unsubscribe.
   */
  on(type: string, fn: (m: TypedMessage) => void): () => void {
    if (type === '*') {
      this.anyHandlers.add(fn);
      return () => this.anyHandlers.delete(fn);
    }
    const set = this.handlers.get(type) ?? new Set();
    this.handlers.set(type, set);
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Connects (no-op when running). */
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.open();
  }

  /** Closes for good. */
  stop(): void {
    this.stopped = true;
    window.clearTimeout(this.retryTimer);
    window.clearInterval(this.pingTimer);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.connected = false;
  }

  /** Sends a message when open (dropped otherwise). */
  send(m: TypedMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    const url = await this.opts.url().catch(() => null);
    if (this.stopped) return;
    if (!url) return this.retry();
    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      return this.retry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.attempts = 0;
      window.clearInterval(this.pingTimer);
      if (this.opts.ping)
        this.pingTimer = window.setInterval(() => this.send(this.opts.ping as TypedMessage), 25_000);
      this.dispatch({ type: 'socket_open' });
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      let m: unknown;
      try {
        m = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (m && typeof m === 'object' && typeof (m as TypedMessage).type === 'string')
        this.dispatch(m as TypedMessage);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.connected;
      this.connected = false;
      window.clearInterval(this.pingTimer);
      if (was) this.dispatch({ type: 'socket_closed' });
      this.retry();
    };
    ws.onerror = () => undefined;
  }

  private retry(): void {
    if (this.stopped) return;
    this.attempts++;
    const delay = Math.min(10_000, 400 * 2 ** Math.min(this.attempts, 5));
    window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => void this.open(), delay);
  }

  private dispatch(m: TypedMessage): void {
    for (const fn of this.anyHandlers) fn(m);
    const set = this.handlers.get(m.type);
    if (!set) return;
    for (const fn of set) {
      try {
        fn(m);
      } catch (err) {
        console.error(`[${this.opts.label}] handler for ${m.type} failed`, err);
      }
    }
  }
}
