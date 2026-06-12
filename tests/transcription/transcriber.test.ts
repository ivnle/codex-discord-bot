import { readFile, stat } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { CliTranscriber } from "../../src/transcription/transcriber.js";

describe("CliTranscriber", () => {
  it("downloads audio, runs the configured CLI with JSON output, returns final text, and cleans up", async () => {
    const execCalls: Array<{
      binary: string;
      args: string[];
      timeout: number | undefined;
    }> = [];
    let tempAudioPath = "";
    const transcriber = new CliTranscriber("fake-transcribe", {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new TextEncoder().encode("fake audio").buffer
      }),
      execFile: async (binary, args, options) => {
        const audioPath = args[0]!;
        tempAudioPath = audioPath;
        await expect(readFile(audioPath, "utf8")).resolves.toBe("fake audio");
        execCalls.push({ binary, args: [...args], timeout: options.timeout });
        return {
          stdout: JSON.stringify({ final: "hello world" }),
          stderr: ""
        };
      }
    });

    await expect(
      transcriber.transcribe("https://cdn.example.test/voice.ogg")
    ).resolves.toBe("hello world");

    expect(execCalls).toEqual([
      {
        binary: "fake-transcribe",
        args: [tempAudioPath, "--json"],
        timeout: 120_000
      }
    ]);
    await expect(stat(tempAudioPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns null and logs when the CLI reports a JSON error object", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const transcriber = new CliTranscriber("fake-transcribe", {
      fetch: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer
      }),
      execFile: async () => ({
        stdout: JSON.stringify({
          error: {
            code: "backend_failed",
            message: "transcription backend failed"
          }
        }),
        stderr: ""
      })
    });

    await expect(
      transcriber.transcribe("https://cdn.example.test/voice.ogg")
    ).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("transcription backend failed")
    );

    errorSpy.mockRestore();
  });
});
