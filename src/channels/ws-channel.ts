/**
 * WebSocket Channel — typed message passing over Bun.serve WebSocket.
 *
 * Uses Bun's native pub/sub: ws.subscribe(topic) / server.publish(topic, msg).
 * Each WebSocket connection is a channel. Messages are JSON-encoded.
 *
 * Server-side usage:
 *   Bun.serve({
 *     websocket: {
 *       data: {} as { taskId: number },
 *       open(ws) {
 *         const channel = new WSChannel(`ws-${ws.data.taskId}`, ws, server);
 *         channel.on("subscribe", (msg) => ws.subscribe(msg.topic));
 *         wsChannels.set(ws.data.taskId, channel);
 *       },
 *       message(ws, msg) {
 *         const channel = wsChannels.get(ws.data.taskId);
 *         channel?.handleMessage(msg);
 *       },
 *       close(ws) {
 *         wsChannels.get(ws.data.taskId)?.handleClose();
 *         wsChannels.delete(ws.data.taskId);
 *       },
 *     },
 *   });
 *
 * Publishing to subscribers from the server (e.g. worker progress → clients):
 *   channel.publish("task:1", { type: "progress", taskId: 1, progress: 50 });
 */

import { BaseChannel, type ChannelMessage } from "../types/channel";

/**
 * Bun ServerWebSocket-like interface for type-safe channel usage.
 * Avoids importing the full bun-types ServerWebSocket to keep this portable.
 */
interface WSLike {
  send(data: string | ArrayBuffer | Uint8Array): number;
  subscribe(topic: string): void;
  unsubscribe(topic: string): void;
  readonly readyState: number;
  close(code?: number, reason?: string): void;
}

/**
 * Bun Server-like interface for publishing to topics.
 */
interface ServerLike {
  publish(topic: string, data: string | ArrayBuffer | Uint8Array): boolean;
}

export class WSChannel<TSend extends ChannelMessage, TRecv extends ChannelMessage>
  extends BaseChannel<TSend, TRecv>
{
  private ws: WSLike;
  private server: ServerLike | null;

  constructor(id: string, ws: WSLike, server?: ServerLike) {
    super(id, "websocket");
    this.ws = ws;
    this.server = server ?? null;
  }

  /**
   * Called from the websocket message handler to deliver an incoming message.
   * Expects JSON-encoded string or ArrayBuffer.
   */
  handleMessage(raw: string | ArrayBuffer | Uint8Array): void {
    if (!this._connected) return;

    try {
      const text = typeof raw === "string"
        ? raw
        : raw instanceof ArrayBuffer
          ? new TextDecoder().decode(raw)
          : new TextDecoder().decode(raw);
      const msg = JSON.parse(text);
      if (msg && typeof msg === "object" && "type" in msg) {
        // JUSTIFIED: runtime check narrows to { type: string }; TRecv requires `type`
        this.dispatch(msg as TRecv);
      }
    } catch (err) {
      console.error(`[ws:${this.id}] failed to parse message:`, err);
    }
  }

  /**
   * Called when the WebSocket connection closes.
   */
  override handleClose(): void {
    this.notifyClosed("websocket closed");
  }

  send(msg: TSend): boolean {
    if (!this._connected) {
      console.error(`[ws:${this.id}] cannot send — channel closed`);
      return false;
    }

    try {
      const json = JSON.stringify(msg);
      const result = this.ws.send(json);
      // Bun's ws.send returns -1 for backpressure, 0 for closed, >0 for success
      if (result === 0) {
        this.notifyClosed("websocket send returned 0 (closed)");
        return false;
      }
      return true;
    } catch (err) {
      console.error(`[ws:${this.id}] send failed:`, err);
      this.notifyClosed(String(err));
      return false;
    }
  }

  /**
   * Publish a message to all subscribers of a topic (excluding this socket).
   * Requires the server reference to be set.
   */
  publish(topic: string, msg: TSend): boolean {
    if (!this.server) {
      console.error(`[ws:${this.id}] cannot publish — no server reference`);
      return false;
    }
    if (!this._connected) return false;

    try {
      const json = JSON.stringify(msg);
      return this.server.publish(topic, json);
    } catch (err) {
      console.error(`[ws:${this.id}] publish failed:`, err);
      return false;
    }
  }

  /**
   * Subscribe this socket to a topic.
   */
  subscribe(topic: string): void {
    if (this._connected) {
      this.ws.subscribe(topic);
    }
  }

  /**
   * Unsubscribe from a topic.
   */
  unsubscribe(topic: string): void {
    if (this._connected) {
      this.ws.unsubscribe(topic);
    }
  }

  override close(code?: number, reason?: string): void {
    try {
      this.ws.close(code, reason);
    } catch {}
    this.notifyClosed("closed explicitly");
  }
}
