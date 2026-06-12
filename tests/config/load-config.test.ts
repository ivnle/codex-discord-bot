import { describe, expect, it } from "vitest";

import {
  ConfigValidationError,
  loadConfigFromString,
  resolveDiscordToken
} from "../../src/config/load.js";

const VALID_CONFIG = `
name: example
discord_token_env: DISCORD_BOT_TOKEN
codex:
  command: codex
  args:
    - app-server
    - --stdio
  cwd: /tmp/project
  model: gpt-5.5
  sandbox: workspace-write
  approval_policy: on-request
access:
  allow_user_ids:
    - "111111111111111111"
  channels:
    - "222222222222222222"
runtime:
  data_dir: ~/.local/share/codex-discord-bot/example
  log_level: info
`;

describe("loadConfigFromString", () => {
  it("parses a valid YAML bot config", () => {
    const config = loadConfigFromString(VALID_CONFIG, "/configs/example.yaml");

    expect(config).toMatchObject({
      name: "example",
      discordTokenEnv: "DISCORD_BOT_TOKEN",
      codex: {
        command: "codex",
        args: ["app-server", "--stdio"],
        cwd: "/tmp/project",
        model: "gpt-5.5",
        sandbox: "workspace-write",
        approvalPolicy: "on-request"
      },
      access: {
        allowUserIds: ["111111111111111111"],
        channels: ["222222222222222222"]
      },
      runtime: {
        logLevel: "info"
      }
    });
    expect(config.runtime.dataDir).toMatch(/codex-discord-bot\/example$/);
  });

  it("rejects missing required fields and malformed access entries", () => {
    expect(() =>
      loadConfigFromString(
        `
discord_token_env: DISCORD_BOT_TOKEN
codex:
  cwd: /tmp/project
access:
  allow_user_ids:
    - 123
  channels: []
runtime:
  data_dir: /tmp/data
`,
        "/configs/bad.yaml"
      )
    ).toThrow(ConfigValidationError);
  });
});

describe("resolveDiscordToken", () => {
  it("reads the token from the configured environment variable", () => {
    const config = loadConfigFromString(VALID_CONFIG, "/configs/example.yaml");

    expect(
      resolveDiscordToken(config, {
        DISCORD_BOT_TOKEN: "configured-env-value"
      })
    ).toBe("configured-env-value");
  });

  it("rejects a missing token without exposing a token value", () => {
    const config = loadConfigFromString(VALID_CONFIG, "/configs/example.yaml");

    expect(() => resolveDiscordToken(config, {})).toThrow(
      /DISCORD_BOT_TOKEN/
    );
  });
});
