/**
 * Socket-layer abstraction. Rooms and sessions only see {@link Connection}s,
 * so the `ws` implementation can be swapped for uWebSockets.js or WebTransport
 * without touching game code (see DECISIONS.md).
 */

/** One client connection carrying binary messages. */
export interface Connection {
  /** Process-unique id. */
  readonly id: number;
  /** Remote address for logs and abuse handling. */
  readonly remoteAddress: string;
  /** Bytes queued in the socket but not yet written to the network. */
  readonly bufferedAmount: number;
  /** True until the connection closes. */
  readonly open: boolean;
  /**
   * Sends one binary message. The transport may keep a reference to `data`
   * until it is written, so callers must not reuse the buffer afterwards.
   *
   * @param droppable - Skip the send when the socket is backed up (snapshots). Reliable traffic passes `false`.
   * @returns False if the message was dropped.
   */
  send(data: Uint8Array, droppable?: boolean): boolean;
  /** Closes the connection. */
  close(code?: number, reason?: string): void;
  /** Incoming message handler. The array may alias a transport buffer: copy anything kept past the call. */
  onMessage: ((data: Uint8Array) => void) | null;
  /** Close handler (called once). */
  onClose: ((code: number, reason: string) => void) | null;
}

/** Accepts connections. */
export interface Transport {
  /** Called for each newly accepted connection. */
  onConnection: ((conn: Connection) => void) | null;
  /** Total bytes sent across all connections. */
  readonly bytesOut: number;
  /** Total bytes received across all connections. */
  readonly bytesIn: number;
  /** Stops accepting and closes every connection. */
  close(): Promise<void>;
}
