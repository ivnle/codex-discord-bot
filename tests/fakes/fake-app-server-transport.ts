import type {
  JsonRpcMessage,
  JsonRpcTransport
} from "../../src/codex/json-rpc.js";

export class FakeAppServerTransport implements JsonRpcTransport {
  started = false;
  stopped = false;
  sent: JsonRpcMessage[] = [];
  nextStartedThreadId = "thread-1";
  resumeError: unknown;
  private handler: ((message: JsonRpcMessage) => void) | undefined;

  onMessage(handler: (message: JsonRpcMessage) => void): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    if ("id" in message && "method" in message) {
      queueMicrotask(() => this.respondTo(message));
    }
  }

  emit(message: JsonRpcMessage): void {
    this.handler?.(message);
  }

  emitCompletedTurn({
    threadId,
    turnId,
    commentaryText,
    finalText
  }: {
    threadId: string;
    turnId: string;
    commentaryText?: string;
    finalText?: string;
  }): void {
    this.emit({
      method: "turn/started",
      params: {
        threadId,
        turn: {
          id: turnId,
          status: "in_progress"
        }
      }
    });
    if (commentaryText !== undefined) {
      this.emit({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: "commentary-1",
            text: commentaryText,
            phase: "commentary",
            memoryCitation: null
          },
          completedAtMs: 1000
        }
      });
    }
    if (finalText !== undefined) {
      this.emit({
        method: "item/completed",
        params: {
          threadId,
          turnId,
          item: {
            type: "agentMessage",
            id: "final-1",
            text: finalText,
            phase: "final_answer",
            memoryCitation: null
          },
          completedAtMs: 1001
        }
      });
    }
    this.emit({
      method: "turn/completed",
      params: {
        threadId,
        turn: {
          id: turnId,
          items: [],
          itemsView: "notLoaded",
          status: "completed",
          error: null,
          startedAt: "2026-06-12T00:00:00.000Z",
          completedAt: "2026-06-12T00:00:01.000Z",
          durationMs: 1000
        }
      }
    });
  }

  sentRequests(): JsonRpcMessage[] {
    return this.sent.filter((message) => "method" in message);
  }

  private respondTo(message: JsonRpcMessage): void {
    if (!("method" in message)) {
      return;
    }
    if (message.method === "thread/start") {
      this.emit({
        id: message.id,
        result: { thread: { id: this.nextStartedThreadId } }
      });
      return;
    }
    if (message.method === "thread/resume") {
      if (this.resumeError !== undefined) {
        this.emit({
          id: message.id,
          error: this.resumeError
        });
        return;
      }
      const params = asRecord(message.params);
      const threadId =
        typeof params.threadId === "string" ? params.threadId : "stored-thread";
      this.emit({
        id: message.id,
        result: { thread: { id: threadId } }
      });
      return;
    }
    this.emit({ id: message.id, result: {} });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
