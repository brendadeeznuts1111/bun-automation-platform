/**
 * Channel — transport-agnostic typed message passing interface.
 *
 * A Channel provides a unified API for sending and receiving typed messages
 * across different transports:
 *   - IPC: parent process ↔ worker subprocess (Bun.spawn ipc)
 *   - WebSocket: server ↔ client (Bun.serve websocket, pub/sub)
 *   - MessagePort: worker ↔ worker (postMessage)
 *
 * Each channel is typed with:
 *   - TSend: message types this side can send
 *   - TRecv: message types this side can receive
 *
 * This allows compile-time verification that messages sent on one side
 * match the types expected on the other side.
 *
 * Usage (parent side):
 *   const channel = createIPCChannel<ParentToWorker, WorkerToParent>(proc);
 *   channel.send({ type: "task", taskId: 1 });
 *   channel.on("progress", (msg) => console.log(msg.progress));
 *
 * Usage (worker side):
 *   const channel = createIPCChannel<WorkerToParent, ParentToWorker>(process);
 *   channel.send({ type: "ready", pid: process.pid });
 *   channel.on("task", (msg) => executeTask(msg.taskId));
 */

/**
 * A message that can be sent over a channel.
 * Must have a `type` field for discriminated union dispatch.
 */
export interface ChannelMessage {
  type: string;
}

/**
 * Handler for a specific message type.
 */
export type MessageHandler<M extends ChannelMessage, T extends M["type"]> = (
  msg: Extract<M, { type: T }>,
) => void | Promise<void>;

/**
 * Subscription handle — call to unsubscribe.
 */
export type Unsubscribe = () => void;

/**
 * A typed channel for sending and receiving messages.
 *
 * @typeParam TSend - message types this side can send
 * @typeParam TRecv - message types this side can receive
 */
export interface Channel<TSend extends ChannelMessage, TRecv extends ChannelMessage> {
  /** Unique identifier for this channel instance. */
  readonly id: string;

  /** The transport type (ipc, websocket, messageport). */
  readonly transport: ChannelTransport;

  /** True if the channel is currently connected and can send messages. */
  readonly connected: boolean;

  /**
   * Send a message over the channel.
   * Returns true if the message was sent, false if the channel is closed.
   */
  send(msg: TSend): boolean;

  /**
   * Subscribe to a specific message type.
   * Returns an unsubscribe function.
   *
   * @example
   * const unsub = channel.on("progress", (msg) => {
   *   console.log(`Task ${msg.taskId}: ${msg.progress}%`);
   * });
   * // later: unsub();
   */
  on<T extends TRecv["type"]>(type: T, handler: MessageHandler<TRecv, T>): Unsubscribe;

  /**
   * Subscribe to all messages on this channel.
   * Returns an unsubscribe function.
   */
  onAny(handler: (msg: TRecv) => void | Promise<void>): Unsubscribe;

  /**
   * Close the channel. No more messages can be sent or received.
   * All handlers are removed.
   */
  close(): void;

  /**
   * Called when the channel is closed (by either side or transport error).
   */
  onClose(handler: (reason?: string) => void): Unsubscribe;
}

/**
 * Transport types supported by the channel interface.
 */
export type ChannelTransport = "ipc" | "websocket" | "messageport";

/**
 * Error thrown when sending on a closed channel.
 */
export class ChannelClosedError extends Error {
  constructor(channelId: string, reason?: string) {
    super(`channel ${channelId} is closed${reason ? `: ${reason}` : ""}`);
    this.name = "ChannelClosedError";
  }
}

/**
 * Base implementation — shared logic for all channel transports.
 * Subclasses implement send(), close(), and the message dispatch mechanism.
 */
export abstract class BaseChannel<TSend extends ChannelMessage, TRecv extends ChannelMessage>
  implements Channel<TSend, TRecv>
{
  readonly id: string;
  readonly transport: ChannelTransport;
  protected _connected: boolean = true;
  protected handlers = new Map<string, Set<(msg: TRecv) => void | Promise<void>>>();
  protected anyHandlers = new Set<(msg: TRecv) => void | Promise<void>>();
  protected closeHandlers = new Set<(reason?: string) => void>();

  constructor(id: string, transport: ChannelTransport) {
    this.id = id;
    this.transport = transport;
  }

  get connected(): boolean {
    return this._connected;
  }

  abstract send(msg: TSend): boolean;
  abstract close(): void;

  on<T extends TRecv["type"]>(type: T, handler: MessageHandler<TRecv, T>): Unsubscribe {
    if (!this._connected) {
      // E9f: Don't allow subscribing on a closed channel — return a no-op unsub
      console.warn(`[channel:${this.id}] subscribing to "${type}" on closed channel — handler will never fire`);
      return () => {};
    }

    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    const wrapped = handler as (msg: TRecv) => void | Promise<void>;
    set.add(wrapped);

    return () => set?.delete(wrapped);
  }

  onAny(handler: (msg: TRecv) => void | Promise<void>): Unsubscribe {
    this.anyHandlers.add(handler);
    return () => this.anyHandlers.delete(handler);
  }

  onClose(handler: (reason?: string) => void): Unsubscribe {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  // Optional overrides for subclasses
  handleClose?(): void;
  setSender?(sender: unknown): void;
  setId?(id: string): void;

  /**
   * Dispatch a received message to all matching handlers.
   * Called by subclasses when a message arrives from the transport.
   * E9g: No-ops if the channel is closed — prevents handler invocation
   * on a dead channel (e.g. after IPC disconnect but before transport stops).
   */
  protected dispatch(msg: TRecv): void {
    if (!this._connected) return;

    // Type-specific handlers
    const set = this.handlers.get(msg.type);
    if (set) {
      for (const handler of set) {
        try {
          handler(msg);
        } catch (err) {
          console.error(`[channel:${this.id}] handler error for "${msg.type}":`, err);
        }
      }
    }

    // Any handlers
    for (const handler of this.anyHandlers) {
      try {
        handler(msg);
      } catch (err) {
        console.error(`[channel:${this.id}] onAny handler error:`, err);
      }
    }
  }

  /**
   * Mark the channel as closed and notify all close handlers.
   */
  protected notifyClosed(reason?: string): void {
    if (!this._connected) return;
    this._connected = false;
    this.handlers.clear();
    this.anyHandlers.clear();
    for (const handler of this.closeHandlers) {
      try {
        handler(reason);
      } catch (err) {
        console.error(`[channel:${this.id}] onClose handler error:`, err);
      }
    }
    this.closeHandlers.clear();
  }
}
