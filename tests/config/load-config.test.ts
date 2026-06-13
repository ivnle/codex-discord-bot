import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

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
      },
      transcription: {
        enabled: false,
        binary: "transcribe"
      }
    });
    expect(config.runtime.dataDir).toMatch(/codex-discord-bot\/example$/);
  });

  it("parses opt-in transcription config", () => {
    const config = loadConfigFromString(
      `${VALID_CONFIG}
transcription:
  enabled: true
  binary: custom-transcribe
`,
      "/configs/example.yaml"
    );

    expect(config.transcription).toEqual({
      enabled: true,
      binary: "custom-transcribe"
    });
  });

  it("keeps codex instructions disabled when instructions_file is absent", () => {
    const config = loadConfigFromString(VALID_CONFIG, "/configs/example.yaml");

    expect(config.codex.instructionsFile).toBeUndefined();
  });

  it("resolves relative codex instructions_file against codex cwd", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-bot-cwd-"));
    const instructionsFile = path.join(cwd, "personas", "reviewer.md");
    mkdirSync(path.dirname(instructionsFile), { recursive: true });
    writeFileSync(instructionsFile, "Review code carefully.\n");

    const config = loadConfigFromString(
      `
name: example
discord_token_env: DISCORD_BOT_TOKEN
codex:
  cwd: ${cwd}
  instructions_file: personas/reviewer.md
`,
      "/configs/example.yaml"
    );

    expect(path.isAbsolute(config.codex.instructionsFile!)).toBe(true);
    expect(config.codex.instructionsFile).toBe(instructionsFile);
  });

  it("expands home-relative codex instructions_file paths", () => {
    const originalHome = process.env.HOME;
    const home = mkdtempSync(path.join(tmpdir(), "codex-bot-home-"));
    const homeInstructions = path.join(home, "bot-instructions.md");
    process.env.HOME = home;

    try {
      writeFileSync(homeInstructions, "Use the test persona.\n");

      const config = loadConfigFromString(
        `
name: example
discord_token_env: DISCORD_BOT_TOKEN
codex:
  cwd: /tmp/project
  instructions_file: ~/bot-instructions.md
`,
        "/configs/example.yaml"
      );

      expect(config.codex.instructionsFile).toBe(homeInstructions);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("rejects invalid codex instructions_file values", () => {
    expect(() =>
      loadConfigFromString(
        `
name: example
discord_token_env: DISCORD_BOT_TOKEN
codex:
  cwd: /tmp/project
  instructions_file: ""
`,
        "/configs/bad.yaml"
      )
    ).toThrow(ConfigValidationError);

    expect(() =>
      loadConfigFromString(
        `
name: example
discord_token_env: DISCORD_BOT_TOKEN
codex:
  cwd: /tmp/project
  instructions_file: 123
`,
        "/configs/bad.yaml"
      )
    ).toThrow(ConfigValidationError);
  });

  it("rejects a configured codex instructions_file that does not exist", () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "codex-bot-cwd-"));

    expect(() =>
      loadConfigFromString(
        `
name: example
discord_token_env: DISCORD_BOT_TOKEN
codex:
  cwd: ${cwd}
  instructions_file: missing.md
`,
        "/configs/bad.yaml"
      )
    ).toThrow(/codex.instructions_file does not exist/);
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

  it("rejects enabled transcription without a binary", () => {
    expect(() =>
      loadConfigFromString(
        `${VALID_CONFIG}
transcription:
  enabled: true
`,
        "/configs/bad.yaml"
      )
    ).toThrow(ConfigValidationError);

    expect(() =>
      loadConfigFromString(
        `${VALID_CONFIG}
transcription:
  enabled: true
  binary: ""
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
