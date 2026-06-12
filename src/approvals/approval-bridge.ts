import type { BotConfig } from "../config/types.js";
import { isUserAllowlisted } from "../access/access-control.js";

export type ApprovalChoice = "approve" | "deny";
export type ApprovalRpcId = string | number;

export type ApprovalKind =
  | "command"
  | "file-change"
  | "permissions"
  | "legacy-command"
  | "legacy-patch";

export interface ApprovalRequest {
  rpcId: ApprovalRpcId;
  approvalId: string;
  method: string;
  kind: ApprovalKind;
  threadId: string;
  turnId: string;
  itemId: string;
  title: string;
  details: string[];
  rawParams: Record<string, unknown>;
}

export interface ApprovalPrompt {
  content: string;
  actions: Array<{ id: ApprovalChoice; label: string }>;
}

export type ApprovalChoiceResult =
  | {
      authorized: true;
      rpcId: ApprovalRpcId;
      response: Record<string, unknown>;
    }
  | {
      authorized: false;
      reason: string;
    };

export function mapServerRequestToApproval(
  request: Record<string, unknown>
): ApprovalRequest {
  const method = stringField(request, "method");
  const rpcId = requestIdField(request, "id");
  const params = recordField(request, "params");

  if (method === "item/commandExecution/requestApproval") {
    return {
      rpcId,
      approvalId: approvalIdForRpcId(rpcId),
      method,
      kind: "command",
      threadId: stringField(params, "threadId"),
      turnId: stringField(params, "turnId"),
      itemId: stringField(params, "itemId"),
      title: "Command approval requested",
      details: compactDetails([
        ["Command", optionalStringField(params, "command")],
        ["CWD", optionalStringField(params, "cwd")],
        ["Reason", optionalStringField(params, "reason")]
      ]),
      rawParams: params
    };
  }

  if (method === "item/fileChange/requestApproval") {
    return sharedApproval(request, "file-change", "File change approval requested");
  }

  if (method === "item/permissions/requestApproval") {
    return sharedApproval(request, "permissions", "Permission approval requested");
  }

  if (method === "execCommandApproval") {
    return legacyApproval(request, "legacy-command", "Command approval requested");
  }

  if (method === "applyPatchApproval") {
    return legacyApproval(request, "legacy-patch", "Patch approval requested");
  }

  throw new Error(`Unsupported approval request method: ${method}`);
}

export function renderApprovalPrompt(approval: ApprovalRequest): ApprovalPrompt {
  return {
    content: [approval.title, ...approval.details].join("\n"),
    actions: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" }
    ]
  };
}

export function mapApprovalChoice(
  approval: ApprovalRequest,
  choice: ApprovalChoice,
  userId: string,
  access: BotConfig["access"]
): ApprovalChoiceResult {
  if (!isUserAllowlisted(access, userId)) {
    return {
      authorized: false,
      reason: "user is not allowlisted"
    };
  }

  return {
    authorized: true,
    rpcId: approval.rpcId,
    response: responseFor(approval.kind, choice)
  };
}

function responseFor(
  kind: ApprovalKind,
  choice: ApprovalChoice
): Record<string, unknown> {
  if (kind === "legacy-command" || kind === "legacy-patch") {
    return { decision: choice === "approve" ? "approved" : "denied" };
  }
  if (kind === "permissions") {
    return choice === "approve"
      ? {
          permissions: ({}),
          scope: "turn"
        }
      : {
          permissions: ({}),
          scope: "turn",
          strictAutoReview: true
        };
  }
  return { decision: choice === "approve" ? "accept" : "decline" };
}

function sharedApproval(
  request: Record<string, unknown>,
  kind: ApprovalKind,
  title: string
): ApprovalRequest {
  const method = stringField(request, "method");
  const params = recordField(request, "params");
  const rpcId = requestIdField(request, "id");
  return {
    rpcId,
    approvalId: approvalIdForRpcId(rpcId),
    method,
    kind,
    threadId: stringField(params, "threadId"),
    turnId: stringField(params, "turnId"),
    itemId: stringField(params, "itemId"),
    title,
    details: compactDetails([
      ["CWD", optionalStringField(params, "cwd")],
      ["Reason", optionalStringField(params, "reason")]
    ]),
    rawParams: params
  };
}

function legacyApproval(
  request: Record<string, unknown>,
  kind: ApprovalKind,
  title: string
): ApprovalRequest {
  const method = stringField(request, "method");
  const params = recordField(request, "params");
  const rpcId = requestIdField(request, "id");
  return {
    rpcId,
    approvalId: approvalIdForRpcId(rpcId),
    method,
    kind,
    threadId: optionalStringField(params, "threadId") ?? "legacy",
    turnId: optionalStringField(params, "turnId") ?? "legacy",
    itemId: optionalStringField(params, "itemId") ?? "legacy",
    title,
    details: compactDetails([
      ["Command", optionalStringField(params, "command")],
      ["Reason", optionalStringField(params, "reason")]
    ]),
    rawParams: params
  };
}

function compactDetails(items: Array<[string, string | undefined]>): string[] {
  return items
    .filter((item): item is [string, string] => item[1] !== undefined)
    .map(([label, value]) => `${label}: ${value}`);
}

function stringField(source: Record<string, unknown>, field: string): string {
  const value = source[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Approval request field ${field} must be a string`);
  }
  return value;
}

function requestIdField(
  source: Record<string, unknown>,
  field: string
): ApprovalRpcId {
  const value = source[field];
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  throw new Error(
    `Approval request field ${field} must be a string or number`
  );
}

function approvalIdForRpcId(rpcId: ApprovalRpcId): string {
  return `${typeof rpcId}:${String(rpcId)}`;
}

function optionalStringField(
  source: Record<string, unknown>,
  field: string
): string | undefined {
  const value = source[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function recordField(
  source: Record<string, unknown>,
  field: string
): Record<string, unknown> {
  const value = source[field];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Approval request field ${field} must be an object`);
  }
  return value as Record<string, unknown>;
}
