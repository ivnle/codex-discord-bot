export type JsonRpcId = string | number;

export type JsonRpcMessage = {
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export interface JsonRpcTransport {
  onClose?(handler: () => void): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(message: JsonRpcMessage): Promise<void>;
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly notificationHandlers: Array<(message: JsonRpcMessage) => void> =
    [];
  private readonly requestHandlers: Array<(message: JsonRpcMessage) => void> = [];

  constructor(private readonly transport: JsonRpcTransport) {
    this.transport.onMessage((message) => this.handleMessage(message));
    this.transport.onClose?.(() => this.rejectPending(new Error("Codex disconnected")));
  }

  async start(): Promise<void> {
    await this.transport.start();
  }

  async stop(): Promise<void> {
    this.rejectPending(new Error("Codex stopped"));
    await this.transport.stop();
  }

  async request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    const message: JsonRpcMessage =
      params === undefined ? { id, method } : { id, method, params };
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not respond to ${method}`));
      }, 15000);
      timeout.unref?.();
      this.pending.set(id, { resolve, reject, timeout });
    });
    void this.transport.send(message).catch((error: unknown) => {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pending.delete(id);
        pending.reject(error);
      }
    });
    return result;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async respond(id: JsonRpcId, result: unknown): Promise<void> {
    await this.transport.send({ id, result });
  }

  onNotification(handler: (message: JsonRpcMessage) => void): void {
    this.notificationHandlers.push(handler);
  }

  onRequest(handler: (message: JsonRpcMessage) => void): void {
    this.requestHandlers.push(handler);
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (
      message.id !== undefined &&
      message.method === undefined &&
      (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))
    ) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (Object.hasOwn(message, "error")) {
        pending.reject(message.error);
        return;
      }
      pending.resolve(message.result);
      return;
    }

    if (message.method && message.id !== undefined) {
      for (const handler of this.requestHandlers) {
        handler(message);
      }
      return;
    }

    if (message.method) {
      for (const handler of this.notificationHandlers) {
        handler(message);
      }
    }
  }
}
