/**
 * {@link Transport} over the `ws` package: binary frames only, no
 * permessage-deflate (snapshots are already bit-packed and deflate costs CPU
 * and latency per frame), Nagle disabled, and backpressure-aware sends.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import type { Connection, Transport } from './types.ts';

/** Options for {@link WsTransport}. */
export interface WsTransportOptions {
  /** URL paths accepted for upgrades. */
  paths?: readonly string[];
  /** Largest accepted inbound message in bytes. */
  maxPayload?: number;
  /** Droppable sends are skipped above this many queued bytes. */
  softBufferLimit?: number;
  /** The connection is closed above this many queued bytes (client not reading). */
  hardBufferLimit?: number;
}

let nextConnectionId = 1;

class WsConnection implements Connection {
  readonly id = nextConnectionId++;
  onMessage: ((data: Uint8Array) => void) | null = null;
  onClose: ((code: number, reason: string) => void) | null = null;
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    readonly remoteAddress: string,
    private readonly owner: WsTransport,
    private readonly softLimit: number,
    private readonly hardLimit: number,
  ) {
    ws.on('message', (data: RawData, isBinary: boolean) => {
      if (!isBinary) return;
      const bytes = toUint8(data);
      owner.countIn(bytes.length);
      this.onMessage?.(bytes);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      if (this.closed) return;
      this.closed = true;
      this.onClose?.(code, reason.toString());
    });
    ws.on('error', () => ws.terminate());
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  get open(): boolean {
    return !this.closed && this.ws.readyState === this.ws.OPEN;
  }

  send(data: Uint8Array, droppable = false): boolean {
    if (!this.open) return false;
    const queued = this.ws.bufferedAmount;
    if (queued > this.hardLimit) {
      this.close(1013, 'backpressure');
      return false;
    }
    if (droppable && queued > this.softLimit) return false;
    this.ws.send(data, { binary: true, compress: false });
    this.owner.countOut(data.length);
    return true;
  }

  close(code = 1000, reason = ''): void {
    if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) this.ws.close(code, reason);
  }
}

function toUint8(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/**
 * WebSocket transport attached to an existing HTTP server (shares the port
 * with `/health`, `/metrics`, …).
 *
 * @example
 * const transport = new WsTransport(httpServer, { paths: ['/ws'] });
 * transport.onConnection = (conn) => rooms.accept(conn);
 */
export class WsTransport implements Transport {
  onConnection: ((conn: Connection) => void) | null = null;
  private readonly wss: WebSocketServer;
  private readonly paths: ReadonlySet<string>;
  private readonly softLimit: number;
  private readonly hardLimit: number;
  private out = 0;
  private in = 0;

  /**
   * @param server - HTTP server whose `upgrade` events are handled.
   * @param opts - Optional settings.
   */
  constructor(
    private readonly server: Server,
    opts: WsTransportOptions = {},
  ) {
    this.paths = new Set(opts.paths ?? ['/ws', '/gs/ws']);
    this.softLimit = opts.softBufferLimit ?? 64 * 1024;
    this.hardLimit = opts.hardBufferLimit ?? 2 * 1024 * 1024;
    this.wss = new WebSocketServer({
      noServer: true,
      perMessageDeflate: false,
      maxPayload: opts.maxPayload ?? 64 * 1024,
      clientTracking: true,
    });
    server.on('upgrade', this.onUpgrade);
  }

  get bytesOut(): number {
    return this.out;
  }

  get bytesIn(): number {
    return this.in;
  }

  /** @internal */
  countOut(n: number): void {
    this.out += n;
  }

  /** @internal */
  countIn(n: number): void {
    this.in += n;
  }

  close(): Promise<void> {
    this.server.off('upgrade', this.onUpgrade);
    for (const ws of this.wss.clients) ws.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }

  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (req.url ?? '/').split('?')[0]!;
    if (!this.paths.has(path)) {
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const raw = (req.socket as { setNoDelay?: (v: boolean) => void }).setNoDelay;
      raw?.call(req.socket, true);
      const addr = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0]?.trim() ?? req.socket.remoteAddress ?? '?';
      const conn = new WsConnection(ws, addr, this, this.softLimit, this.hardLimit);
      this.onConnection?.(conn);
    });
  };
}
