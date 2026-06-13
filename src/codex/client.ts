import type { ApprovalPolicy, SandboxMode } from "../config/types.js";

export interface CodexTextInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface CodexThreadOptions {
  cwd: string;
  model?: string;
  sandbox?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
}

export interface CodexStartTurnRequest {
  threadId: string;
  clientUserMessageId: string;
  input: CodexTextInput[];
  cwd?: string;
  model?: string;
  approvalPolicy?: ApprovalPolicy;
}

export interface CodexFinalMessage {
  threadId: string;
  text: string;
}

export type CodexFinalMessageHandler = (
  message: CodexFinalMessage
) => void | Promise<void>;

export interface CodexTurnCompleted {
  threadId: string;
}

export type CodexTurnCompletedHandler = (
  message: CodexTurnCompleted
) => void | Promise<void>;

export type CodexApprovalRequestHandler = (
  request: Record<string, unknown>
) => void | Promise<void>;

export type CodexRpcId = string | number;

export interface CodexClient {
  connect(): Promise<void>;
  startThread(options: CodexThreadOptions): Promise<string>;
  resumeThread(threadId: string, options?: CodexThreadOptions): Promise<string>;
  startTurn(request: CodexStartTurnRequest): Promise<void>;
  interrupt(): Promise<void>;
  compact(threadId: string): Promise<void>;
  onFinalMessage(handler: CodexFinalMessageHandler): void;
  onTurnCompleted(handler: CodexTurnCompletedHandler): void;
  onApprovalRequest(handler: CodexApprovalRequestHandler): void;
  sendApprovalResponse(
    rpcId: CodexRpcId,
    response: Record<string, unknown>
  ): Promise<void>;
  stop?(): Promise<void>;
}
