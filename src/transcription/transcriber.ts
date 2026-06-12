import { execFile as nodeExecFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const TRANSCRIBE_TIMEOUT_MS = 120_000;

export interface Transcriber {
  transcribe(audioUrl: string): Promise<string | null>;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  statusText: string;
  arrayBuffer(): Promise<ArrayBuffer>;
}

type FetchDependency = (url: string) => Promise<FetchResponse>;

interface ExecFileOptions {
  timeout: number;
}

type ExecFileDependency = (
  binary: string,
  args: readonly string[],
  options: ExecFileOptions
) => Promise<{ stdout: string; stderr: string }>;

interface CliTranscriberDependencies {
  fetch?: FetchDependency;
  execFile?: ExecFileDependency;
}

const execFileAsync = promisify(nodeExecFile) as (
  file: string,
  args: readonly string[],
  options: ExecFileOptions
) => Promise<{ stdout: string | Buffer; stderr: string | Buffer }>;

export class CliTranscriber implements Transcriber {
  private readonly fetchImpl: FetchDependency;
  private readonly execFileImpl: ExecFileDependency;

  constructor(
    private readonly binary: string,
    dependencies: CliTranscriberDependencies = {}
  ) {
    this.fetchImpl = dependencies.fetch ?? ((url) => fetch(url));
    this.execFileImpl = dependencies.execFile ?? defaultExecFile;
  }

  async transcribe(audioUrl: string): Promise<string | null> {
    let tempDir: string | undefined;
    try {
      tempDir = await mkdtemp(path.join(tmpdir(), "codex-discord-audio-"));
      const audioPath = path.join(tempDir, `attachment${extensionFor(audioUrl)}`);
      await this.download(audioUrl, audioPath);

      const result = await this.execFileImpl(
        this.binary,
        [audioPath, "--json"],
        { timeout: TRANSCRIBE_TIMEOUT_MS }
      );
      return parseTranscript(result.stdout);
    } catch (error) {
      logTranscriptionError(error);
      return null;
    } finally {
      if (tempDir) {
        await rm(tempDir, { recursive: true, force: true }).catch((error) => {
          console.error(`Audio transcription cleanup failed: ${errorText(error)}`);
        });
      }
    }
  }

  private async download(audioUrl: string, audioPath: string): Promise<void> {
    const response = await this.fetchImpl(audioUrl);
    if (!response.ok) {
      throw new Error(
        `download failed with HTTP ${response.status} ${response.statusText}`
      );
    }

    await writeFile(audioPath, Buffer.from(await response.arrayBuffer()));
  }
}

async function defaultExecFile(
  binary: string,
  args: readonly string[],
  options: ExecFileOptions
): Promise<{ stdout: string; stderr: string }> {
  const result = await execFileAsync(binary, args, options);
  return {
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  };
}

function parseTranscript(stdout: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    console.error("Audio transcription failed: transcribe output was not JSON");
    return null;
  }

  if (!isRecord(parsed)) {
    console.error("Audio transcription failed: transcribe output was not an object");
    return null;
  }

  if (isRecord(parsed.error)) {
    console.error(`Audio transcription failed: ${cliErrorText(parsed.error)}`);
    return null;
  }

  if (typeof parsed.final !== "string") {
    console.error("Audio transcription failed: transcribe output lacked final text");
    return null;
  }

  return parsed.final;
}

function logTranscriptionError(error: unknown): void {
  const cliError = cliErrorFromRejectedExec(error);
  console.error(`Audio transcription failed: ${cliError ?? errorText(error)}`);
}

function cliErrorFromRejectedExec(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.stdout !== "string") {
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(error.stdout);
    if (isRecord(parsed) && isRecord(parsed.error)) {
      return cliErrorText(parsed.error);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function cliErrorText(error: Record<string, unknown>): string {
  const message = typeof error.message === "string" ? error.message : undefined;
  const code = typeof error.code === "string" ? error.code : undefined;
  return message ?? code ?? "transcribe CLI returned an error";
}

function extensionFor(audioUrl: string): string {
  try {
    const ext = path.extname(new URL(audioUrl).pathname);
    return ext || ".audio";
  } catch {
    return ".audio";
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
