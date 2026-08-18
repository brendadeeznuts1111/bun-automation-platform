/**
 * IPC Channel — typed message passing over Bun.spawn IPC.
 *
 * Parent side: wraps a Bun.Subprocess with ipc enabled.
 * Worker side: wraps the global `process` object (process.send / process.on).
 *
 * Both sides use the same Channel interface — the only difference is which
 * direction TSend/TRecv point.
 *
 * Parent usage:
 *   const proc = Bun.spawn({ ipc: (msg) => channel.handleMessage(msg), ... });
 *   const channel = new IPCChannel("worker-0", proc);
 *
 * Worker usage:
 *   const channel = new IPCChannel("worker-self", process);
 *   channel.on("task", (msg) => executeTask(msg.taskId));
 *   channel.send({ type: "ready", pid: process.pid });
 */

import { BaseChannel, type ChannelMessage } from "../types/channel";

/**
 * Parent-side sender: a Bun subprocess with IPC.
 * Has .send(msg) and .pid and .exited properties.
 */
interface IPCSender {
  send(msg: unknown): void;
  readonly pid?: number;
  readonly exited: Promise<number | null>;
}

/**
 * Worker-side sender: the global process object.
 * Has process.send(msg) and process.on("message", cb).
 */
interface ProcessSender {
  send?(msg: unknown): void;
  on(event: "message", cb: (msg: unknown) => void): void;
  off?(event: "message", cb: (msg: unknown) => void): void;
  readonly pid?: number;
}

/**
 * Either type of sender — we detect at runtime which one we have.
 */
type Sender = IPCSender | ProcessSender;

function isProcessSender(s: Sender): s is ProcessSender {
  // JUSTIFIED: narrowing union member to check discriminating property; cast safe
  return typeof (s as ProcessSender).on === "function";
}

export class IPCChannel<TSend extends ChannelMessage, TRecv extends ChannelMessage> extends BaseChannel<TSend, TRecv> {
  private sender: Sender;
  private messageHandler: ((msg: unknown) => void) | null = null;

  /**
   * Create an IPC channel.
   *
   * @param id Channel identifier (e.g. "worker-0" or "worker-self")
   * @param sender On parent: the Bun.Subprocess. On worker: the process object.
   */
  constructor(id: string, sender: Sender) {
    super(id, "ipc");
    this.sender = sender;

    // Worker side: listen for messages on process
    if (isProcessSender(sender)) {
      this.messageHandler = (msg: unknown) => {
        if (this._connected && msg && typeof msg === "object" && "type" in msg) {
          // JUSTIFIED: runtime check narrows to { type: string }; TRecv requires `type`
          this.dispatch(msg as TRecv);
        }
      };
      sender.on("message", this.messageHandler);
    }
    // Parent side: messages are delivered via the ipc callback in Bun.spawn,
    // which calls channel.handleMessage(msg) directly.
  }

  /**
   * Update the sender (used by pool.ts when the proc is created after the channel).
   * Only valid for parent-side channels where the initial sender is a placeholder.
   */
  override setSender(sender: Sender): void {
    this.sender = sender;
  }

  /**
   * Update the channel id (used by pool.ts after proc.pid is known).
   */
  override setId(id: string): void {
    // JUSTIFIED: `id` is readonly in Channel interface; subclasses need to update after construction
    (this as { id: string }).id = id;
  }

  /**
   * Parent-side: called from the Bun.spawn ipc callback to deliver a message.
   */
  handleMessage(msg: unknown): void {
    if (this._connected && msg && typeof msg === "object" && "type" in msg) {
      // JUSTIFIED: runtime check narrows to { type: string }; TRecv requires `type`
      this.dispatch(msg as TRecv);
    }
  }

  /**
   * E9/Bug 1: Called when the IPC channel disconnects (onDisconnect callback).
   * Without this, the channel stays "connected" after the worker exits,
   * and handlers keep firing on a dead channel.
   */
  override handleClose(): void {
    this.notifyClosed("ipc disconnected");
  }

  send(msg: TSend): boolean {
    if (!this._connected) {
      console.error(`[ipc:${this.id}] cannot send — channel closed`);
      return false;
    }

    try {
      if (isProcessSender(this.sender)) {
        if (typeof this.sender.send !== "function") {
          console.error(`[ipc:${this.id}] process.send is not available — IPC channel closed`);
          this.notifyClosed("process.send unavailable");
          return false;
        }
        this.sender.send(msg);
      } else {
        // Parent side: proc.send(msg)
        this.sender.send(msg);
      }
      return true;
    } catch (err) {
      console.error(`[ipc:${this.id}] send failed:`, err);
      this.notifyClosed(String(err));
      return false;
    }
  }

  close(): void {
    if (isProcessSender(this.sender) && this.messageHandler) {
      this.sender.off?.("message", this.messageHandler);
    }
    this.notifyClosed("closed explicitly");
  }
}
