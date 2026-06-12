export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

export type SandboxMode =
  | "read-only"
  | "workspace-write"
  | "danger-full-access";

export interface BotConfig {
  name: string;
  discordTokenEnv: string;
  codex: {
    command: string;
    args: string[];
    cwd: string;
    model?: string;
    sandbox?: SandboxMode;
    approvalPolicy?: ApprovalPolicy;
  };
  access: {
    allowUserIds: string[];
    channels: string[];
  };
  runtime: {
    dataDir: string;
    logLevel: "debug" | "info" | "warn" | "error";
  };
}
