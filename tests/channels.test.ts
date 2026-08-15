import { describe, expect, it, mock } from "bun:test";
import type { Channel } from "../src/types/channel";
import { IPCChannel } from "../src/channels/ipc-channel";
import { WSChannel } from "../src/channels/ws-channel";
import type { ParentToWorkerMessage, WorkerToParentMessage } from "../src/types/ipc";

// --- Mock helpers ---

/** Create a mock process object for worker-side IPC testing */
function createMockProcess() {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    pid: 12345,
    send: mock(() => {}),
    on: mock((event: string, cb: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(cb);
    }),
    off: mock((event: string, cb: (...args: unknown[]) => void) => {
      if (handlers[event]) {
        handlers[event] = handlers[event].filter((h) => h !== cb);
      }
    }),
    // Test helper: simulate receiving a message
    _emit(event: string, ...args: unknown[]) {
      handlers[event]?.forEach((h) => h(...args));
    },
  };
}

/** Create a mock Bun subprocess for parent-side IPC testing */
function createMockSubprocess() {
  return {
    pid: 67890,
    send: mock(() => {}),
    exited: Promise.resolve(0),
  };
}

/** Create a mock WebSocket */
function createMockWS() {
  return {
    send: mock(() => 1), // 1 = success
    subscribe: mock(() => {}),
    unsubscribe: mock(() => {}),
    readyState: 1, // OPEN
    close: mock(() => {}),
  };
}

/** Create a mock Bun server */
function createMockServer() {
  return {
    publish: mock(() => true),
  };
}

// --- Tests ---

describe("Channel Interface", () => {
  describe("BaseChannel", () => {
    it("tracks connected state", () => {
      const proc = createMockProcess();
      const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("test", proc);
      expect(channel.connected).toBe(true);
      expect(channel.transport).toBe("ipc");
      expect(channel.id).toBe("test");
    });

    it("on() returns an unsubscribe function", () => {
      const proc = createMockProcess();
      const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("test", proc);
      const handler = mock(() => {});
      const unsub = channel.on("task", handler);
      expect(typeof unsub).toBe("function");
      unsub();
      // Handler should not be called after unsubscribe
      proc._emit("message", { type: "task", taskId: 1 });
      expect(handler).not.toHaveBeenCalled();
    });

    it("onAny() receives all messages", () => {
      const proc = createMockProcess();
      const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("test", proc);
      const handler = mock(() => {});
      channel.onAny(handler);
      proc._emit("message", { type: "ready", pid: 123 });
      proc._emit("message", { type: "progress", taskId: 1, progress: 50 });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("onClose() is called when channel closes", () => {
      const proc = createMockProcess();
      const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("test", proc);
      const closeHandler = mock(() => {});
      channel.onClose(closeHandler);
      channel.close();
      expect(closeHandler).toHaveBeenCalledTimes(1);
      expect(channel.connected).toBe(false);
    });

    it("handlers are cleared after close", () => {
      const proc = createMockProcess();
      const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("test", proc);
      const handler = mock(() => {});
      channel.on("task", handler);
      channel.close();
      proc._emit("message", { type: "task", taskId: 1 });
      expect(handler).not.toHaveBeenCalled();
    });

    it("handler errors are caught and logged", () => {
      const proc = createMockProcess();
      const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("test", proc);
      const errorHandler = mock(() => { throw new Error("handler error"); });
      const goodHandler = mock(() => {});
      channel.on("task", errorHandler);
      channel.on("task", goodHandler);
      // Should not throw — error is caught
      expect(() => proc._emit("message", { type: "task", taskId: 1 })).not.toThrow();
      // Good handler should still be called even after error handler throws
      expect(goodHandler).toHaveBeenCalledTimes(1);
    });
  });
});

describe("IPCChannel (worker side)", () => {
  it("sends messages via process.send", () => {
    const proc = createMockProcess();
    const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("worker", proc);
    const msg: WorkerToParentMessage = { type: "ready", pid: 12345 };
    const result = channel.send(msg);
    expect(result).toBe(true);
    expect(proc.send).toHaveBeenCalledWith(msg);
  });

  it("receives messages via process.on('message')", () => {
    const proc = createMockProcess();
    const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("worker", proc);
    const taskHandler = mock(() => {});
    channel.on("task", taskHandler);
    proc._emit("message", { type: "task", taskId: 42 });
    expect(taskHandler).toHaveBeenCalledWith({ type: "task", taskId: 42 });
  });

  it("dispatches only to matching type handlers", () => {
    const proc = createMockProcess();
    const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("worker", proc);
    const taskHandler = mock(() => {});
    const shutdownHandler = mock(() => {});
    channel.on("task", taskHandler);
    channel.on("shutdown", shutdownHandler);
    proc._emit("message", { type: "task", taskId: 1 });
    expect(taskHandler).toHaveBeenCalledTimes(1);
    expect(shutdownHandler).not.toHaveBeenCalled();
  });

  it("returns false when sending on closed channel", () => {
    const proc = createMockProcess();
    const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("worker", proc);
    channel.close();
    const result = channel.send({ type: "ready", pid: 123 });
    expect(result).toBe(false);
  });

  it("returns false when process.send is not available", () => {
    const proc = createMockProcess();
    // JUSTIFIED: deleting property from mock for testing; cast allows `delete` on typed object
    delete (proc as { send?: unknown }).send;
    const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("worker", proc);
    const result = channel.send({ type: "ready", pid: 123 });
    expect(result).toBe(false);
  });

  it("setSender updates the sender", () => {
    // Parent side: start with placeholder, then set real proc
    const placeholder = {} as import("bun").Subprocess<"ignore", "inherit", "inherit">;
    const channel = new IPCChannel<ParentToWorkerMessage, WorkerToParentMessage>("parent", placeholder);
    const realProc = createMockSubprocess();
    channel.setSender?.(realProc);
    channel.setId?.("worker-67890");
    expect(channel.id).toBe("worker-67890");
    const result = channel.send({ type: "task", taskId: 1 });
    expect(result).toBe(true);
    expect(realProc.send).toHaveBeenCalledWith({ type: "task", taskId: 1 });
  });

  it("handleMessage dispatches on parent side", () => {
    const proc = createMockSubprocess();
    const channel = new IPCChannel<ParentToWorkerMessage, WorkerToParentMessage>("parent", proc);
    const progressHandler = mock(() => {});
    channel.on("progress", progressHandler);
    channel.handleMessage({ type: "progress", taskId: 1, progress: 50 });
    expect(progressHandler).toHaveBeenCalledWith({ type: "progress", taskId: 1, progress: 50 });
  });

  it("ignores non-object messages", () => {
    const proc = createMockProcess();
    const channel = new IPCChannel<WorkerToParentMessage, ParentToWorkerMessage>("worker", proc);
    const handler = mock(() => {});
    channel.onAny(handler);
    proc._emit("message", "not an object");
    proc._emit("message", null);
    proc._emit("message", 42);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("WSChannel (WebSocket)", () => {
  // Client side: sends ParentToWorker (commands), receives WorkerToParent (progress/results)
  type WSClientSend = ParentToWorkerMessage;
  type WSClientRecv = WorkerToParentMessage;

  it("sends JSON-encoded messages", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    const result = channel.send({ type: "task", taskId: 1 });
    expect(result).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "task", taskId: 1 }));
  });

  it("handleMessage parses JSON and dispatches", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    const handler = mock(() => {});
    channel.on("result", handler);
    channel.handleMessage(JSON.stringify({ type: "result", taskId: 1, result: "ok" }));
    expect(handler).toHaveBeenCalledWith({ type: "result", taskId: 1, result: "ok" });
  });

  it("handleMessage handles ArrayBuffer input", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    const handler = mock(() => {});
    channel.on("ready", handler);
    const json = JSON.stringify({ type: "ready", pid: 123 });
    const buf = new TextEncoder().encode(json).buffer;
    channel.handleMessage(buf);
    expect(handler).toHaveBeenCalledWith({ type: "ready", pid: 123 });
  });

  it("handleMessage handles Uint8Array input", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    const handler = mock(() => {});
    channel.on("error", handler);
    const json = JSON.stringify({ type: "error", taskId: 1, error: "fail" });
    channel.handleMessage(new TextEncoder().encode(json));
    expect(handler).toHaveBeenCalledWith({ type: "error", taskId: 1, error: "fail" });
  });

  it("handleMessage ignores invalid JSON", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    const handler = mock(() => {});
    channel.onAny(handler);
    expect(() => channel.handleMessage("not json")).not.toThrow();
    expect(handler).not.toHaveBeenCalled();
  });

  it("handleClose marks channel as closed", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    const closeHandler = mock(() => {});
    channel.onClose(closeHandler);
    channel.handleClose();
    expect(channel.connected).toBe(false);
    expect(closeHandler).toHaveBeenCalledWith("websocket closed");
  });

  it("publish sends via server.publish", () => {
    const ws = createMockWS();
    const server = createMockServer();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws, server);
    const result = channel.publish("task:1", { type: "task", taskId: 1 });
    expect(result).toBe(true);
    expect(server.publish).toHaveBeenCalledWith("task:1", JSON.stringify({ type: "task", taskId: 1 }));
  });

  it("publish returns false without server reference", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    const result = channel.publish("task:1", { type: "task", taskId: 1 });
    expect(result).toBe(false);
  });

  it("subscribe calls ws.subscribe", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    channel.subscribe("task:42");
    expect(ws.subscribe).toHaveBeenCalledWith("task:42");
  });

  it("unsubscribe calls ws.unsubscribe", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    channel.unsubscribe("task:42");
    expect(ws.unsubscribe).toHaveBeenCalledWith("task:42");
  });

  it("send returns false when ws.send returns 0 (closed)", () => {
    const ws = createMockWS();
    ws.send = mock(() => 0); // 0 = closed
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    const result = channel.send({ type: "task", taskId: 1 });
    expect(result).toBe(false);
    expect(channel.connected).toBe(false);
  });

  it("close calls ws.close", () => {
    const ws = createMockWS();
    const channel = new WSChannel<WSClientSend, WSClientRecv>("ws-1", ws);
    channel.close(1000, "bye");
    expect(ws.close).toHaveBeenCalledWith(1000, "bye");
    expect(channel.connected).toBe(false);
  });
});

describe("Channel type safety", () => {
  it("IPC channel enforces message type at compile time", () => {
    const proc = createMockProcess();
    const channel: Channel<WorkerToParentMessage, ParentToWorkerMessage> = new IPCChannel("test", proc);
    // This compiles — valid WorkerToParentMessage
    channel.send({ type: "ready", pid: 123 });
    channel.send({ type: "progress", taskId: 1, progress: 50 });
    channel.send({ type: "result", taskId: 1, result: "ok" });
    channel.send({ type: "error", taskId: 1, error: "fail" });
    // These would not compile (TS error):
    // channel.send({ type: "task", taskId: 1 }); // ParentToWorker, not WorkerToParent
    // channel.send({ type: "invalid" }); // not in union
  });

  it("WS channel can publish typed messages", () => {
    const ws = createMockWS();
    const server = createMockServer();
    const channel: Channel<ParentToWorkerMessage, WorkerToParentMessage> = new WSChannel("ws-1", ws, server);
    // JUSTIFIED: Channel interface doesn't include publish(); cast to WSChannel for WS-specific method
    (channel as WSChannel<ParentToWorkerMessage, WorkerToParentMessage>).publish("task:1", {
      type: "task",
      taskId: 1,
    });
    expect(server.publish).toHaveBeenCalled();
  });
});
