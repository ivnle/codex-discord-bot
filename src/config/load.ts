import { homedir } from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import YAML from "yaml";

import type { ApprovalPolicy, BotConfig, SandboxMode } from "./types.js";

const APPROVAL_POLICIES = new Set<ApprovalPolicy>([
  "untrusted",
  "on-failure",
  "on-request",
  "never"
]);

const SANDBOX_MODES = new Set<SandboxMode>([
  "read-only",
  "workspace-write",
  "danger-full-access"
]);

const LOG_LEVELS = new Set(["debug", "info", "warn", "error"]);

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    readonly issues: string[]
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

export async function loadConfig(configPath: string): Promise<BotConfig> {
  const source = await readFile(configPath, "utf8");
  return loadConfigFromString(source, configPath);
}

export function loadConfigFromString(
  source: string,
  configPath = "config.yaml"
): BotConfig {
  const raw = YAML.parse(source) as unknown;
  const issues: string[] = [];

  if (!isRecord(raw)) {
    throw new ConfigValidationError("Config must be a YAML object", [
      "config must be a YAML object"
    ]);
  }

  const name = requiredString(raw.name, "name", issues);
  const discordTokenEnv = requiredString(
    raw.discord_token_env,
    "discord_token_env",
    issues
  );
  const codexRaw = getRecord(raw.codex, "codex", issues);
  const cwd = requiredString(codexRaw?.cwd, "codex.cwd", issues);
  const accessRaw = getOptionalRecord(raw.access, "access", issues);
  const runtimeRaw = getOptionalRecord(raw.runtime, "runtime", issues);
  const transcriptionRaw = getOptionalRecord(
    raw.transcription,
    "transcription",
    issues
  );

  const command = optionalString(codexRaw?.command, "codex.command", issues);
  const args = optionalStringArray(codexRaw?.args, "codex.args", issues);
  const model = optionalString(codexRaw?.model, "codex.model", issues);
  const instructionsFile = optionalString(
    codexRaw?.instructions_file,
    "codex.instructions_file",
    issues
  );
  const sandbox = optionalEnum(
    codexRaw?.sandbox,
    "codex.sandbox",
    SANDBOX_MODES,
    issues
  );
  const approvalPolicy = optionalEnum(
    codexRaw?.approval_policy,
    "codex.approval_policy",
    APPROVAL_POLICIES,
    issues
  );
  const allowUserIds = optionalStringArray(
    accessRaw?.allow_user_ids,
    "access.allow_user_ids",
    issues
  );
  const channels = optionalStringArray(
    accessRaw?.channels,
    "access.channels",
    issues
  );
  const dataDir = optionalString(
    runtimeRaw?.data_dir,
    "runtime.data_dir",
    issues
  );
  const logLevel = optionalEnum(
    runtimeRaw?.log_level,
    "runtime.log_level",
    LOG_LEVELS,
    issues
  );
  const transcriptionEnabled = optionalBoolean(
    transcriptionRaw?.enabled,
    "transcription.enabled",
    issues
  );
  const transcriptionBinary =
    transcriptionEnabled === true
      ? requiredString(
          transcriptionRaw?.binary,
          "transcription.binary",
          issues
        )
      : optionalString(
          transcriptionRaw?.binary,
          "transcription.binary",
          issues
        );
  const resolvedInstructionsFile = instructionsFile
    ? resolveConfigPath(instructionsFile, cwd)
    : undefined;
  if (resolvedInstructionsFile && !existsSync(resolvedInstructionsFile)) {
    issues.push(
      `codex.instructions_file does not exist: ${resolvedInstructionsFile}`
    );
  }

  if (issues.length > 0) {
    throw new ConfigValidationError(
      `Invalid config ${configPath}: ${issues.join("; ")}`,
      issues
    );
  }

  return {
    name,
    discordTokenEnv,
    codex: {
      command: command ?? "codex",
      args: args ?? ["app-server", "--stdio"],
      cwd,
      ...(model ? { model } : {}),
      ...(sandbox ? { sandbox } : {}),
      ...(approvalPolicy ? { approvalPolicy } : {}),
      ...(resolvedInstructionsFile
        ? { instructionsFile: resolvedInstructionsFile }
        : {})
    },
    access: {
      allowUserIds: allowUserIds ?? [],
      channels: channels ?? []
    },
    runtime: {
      dataDir: resolveConfigPath(
        dataDir ?? path.join(".data", name),
        path.dirname(configPath)
      ),
      logLevel: (logLevel ?? "info") as BotConfig["runtime"]["logLevel"]
    },
    transcription: {
      enabled: transcriptionEnabled ?? false,
      binary: transcriptionBinary ?? "transcribe"
    }
  };
}

export function resolveDiscordToken(
  config: Pick<BotConfig, "discordTokenEnv">,
  env: NodeJS.ProcessEnv = process.env
): string {
  const token = env[config.discordTokenEnv];
  if (!token) {
    throw new Error(
      `Discord token environment variable ${config.discordTokenEnv} is not set`
    );
  }
  return token;
}

function resolveConfigPath(value: string, baseDir: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(homedir(), value.slice(2));
  }
  if (path.isAbsolute(value)) {
    return value;
  }
  return path.resolve(baseDir, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getRecord(
  value: unknown,
  field: string,
  issues: string[]
): Record<string, unknown> | undefined {
  if (isRecord(value)) {
    return value;
  }
  issues.push(`${field} must be an object`);
  return undefined;
}

function getOptionalRecord(
  value: unknown,
  field: string,
  issues: string[]
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  return getRecord(value, field, issues);
}

function requiredString(
  value: unknown,
  field: string,
  issues: string[]
): string {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  issues.push(`${field} is required`);
  return "";
}

function optionalString(
  value: unknown,
  field: string,
  issues: string[]
): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }
  issues.push(`${field} must be a non-empty string`);
  return undefined;
}

function optionalBoolean(
  value: unknown,
  field: string,
  issues: string[]
): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value === "boolean") {
    return value;
  }
  issues.push(`${field} must be a boolean`);
  return undefined;
}

function optionalStringArray(
  value: unknown,
  field: string,
  issues: string[]
): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  ) {
    return value;
  }
  issues.push(`${field} must be an array of non-empty strings`);
  return undefined;
}

function optionalEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: ReadonlySet<T>,
  issues: string[]
): T | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (
    typeof value === "string" &&
    (allowed as ReadonlySet<string>).has(value)
  ) {
    return value as T;
  }
  issues.push(`${field} has an unsupported value`);
  return undefined;
}
