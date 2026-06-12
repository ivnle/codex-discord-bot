import { describe, expect, it } from "vitest";

import {
  mapApprovalChoice,
  mapServerRequestToApproval,
  renderApprovalPrompt
} from "../../src/approvals/approval-bridge.js";

const commandServerRequest = {
  id: "rpc-1",
  method: "item/commandExecution/requestApproval",
  params: {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    startedAtMs: 1000,
    command: "npm test",
    cwd: "/tmp/project",
    reason: "command needs approval"
  }
};

describe("approval bridge", () => {
  it("maps app-server approval requests to Discord prompts", () => {
    const approval = mapServerRequestToApproval(commandServerRequest);
    const prompt = renderApprovalPrompt(approval);

    expect(approval).toMatchObject({
      rpcId: "rpc-1",
      kind: "command",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1"
    });
    expect(prompt.content).toContain("Command approval requested");
    expect(prompt.content).toContain("npm test");
    expect(prompt.actions).toEqual([
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" }
    ]);
  });

  it("maps allowlisted approval and deny choices to app-server responses", () => {
    const approval = mapServerRequestToApproval(commandServerRequest);

    expect(
      mapApprovalChoice(approval, "approve", "user-1", {
        allowUserIds: ["user-1"],
        channels: []
      })
    ).toEqual({
      authorized: true,
      rpcId: "rpc-1",
      response: { decision: "accept" }
    });

    expect(
      mapApprovalChoice(approval, "deny", "user-1", {
        allowUserIds: ["user-1"],
        channels: []
      })
    ).toEqual({
      authorized: true,
      rpcId: "rpc-1",
      response: { decision: "decline" }
    });
  });

  it("preserves numeric JSON-RPC request ids in approval responses", () => {
    const approval = mapServerRequestToApproval({
      ...commandServerRequest,
      id: 42
    });

    expect(approval).toMatchObject({
      approvalId: "number:42",
      rpcId: 42
    });
    expect(
      mapApprovalChoice(approval, "approve", "user-1", {
        allowUserIds: ["user-1"],
        channels: []
      })
    ).toEqual({
      authorized: true,
      rpcId: 42,
      response: { decision: "accept" }
    });
  });

  it("rejects approval choices from users outside the allowlist", () => {
    const approval = mapServerRequestToApproval(commandServerRequest);

    expect(
      mapApprovalChoice(approval, "approve", "user-2", {
        allowUserIds: ["user-1"],
        channels: []
      })
    ).toEqual({
      authorized: false,
      reason: "user is not allowlisted"
    });
  });
});
