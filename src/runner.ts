import { spawn, type ChildProcess } from "node:child_process";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  MODEL_ROLES,
  type RoleRunInput,
  type RoleRunResult,
  type RoleYield,
} from "./types.js";

export const TEAM_YIELD_MARKER = "VEX_TEAM_YIELD:";

export interface PiChildRunnerOptions {
  extensionPath: string;
  command?: string;
  commandArguments?: string[];
  environment?: NodeJS.ProcessEnv;
}

interface PiEventMessage {
  role?: string;
  toolName?: string;
  content?: Array<{ type?: string; text?: string }>;
}

function textFromMessage(message: PiEventMessage | undefined): string {
  return (message?.content ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

export function parseTeamYield(text: string): RoleYield | undefined {
  const marker = text.lastIndexOf(TEAM_YIELD_MARKER);
  if (marker < 0) return undefined;
  const candidate = text.slice(marker + TEAM_YIELD_MARKER.length).trim();
  try {
    const parsed = JSON.parse(candidate) as RoleYield;
    if (
      !MODEL_ROLES.includes(parsed.role) ||
      !["completed", "skipped", "blocked", "failed"].includes(parsed.status) ||
      typeof parsed.summary !== "string" ||
      parsed.summary.length === 0 ||
      !Array.isArray(parsed.artifacts) ||
      !parsed.artifacts.every((artifact) => typeof artifact === "string")
    ) {
      return undefined;
    }
    return parsed;
  } catch {
    return undefined;
  }
}

async function commandExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePiInvocation(
  options: PiChildRunnerOptions,
): Promise<{ command: string; args: string[] }> {
  if (options.command)
    return { command: options.command, args: options.commandArguments ?? [] };

  const currentScript = process.argv[1];
  if (
    currentScript &&
    /(?:^|[\\/])dist[\\/](?:bun[\\/])?cli\.js$/i.test(currentScript) &&
    (await commandExists(currentScript))
  ) {
    return { command: process.execPath, args: [currentScript] };
  }
  const executableName = path.basename(process.execPath).toLowerCase();
  if (!/^(?:node|bun)(?:\.exe)?$/.test(executableName))
    return { command: process.execPath, args: [] };
  return { command: "pi", args: [] };
}

function compactContext(
  value: Record<string, unknown>,
  maxCharacters = 24_000,
): string {
  const json = JSON.stringify(value, null, 2);
  return json.length <= maxCharacters
    ? json
    : `${json.slice(0, maxCharacters)}\n... context truncated by VEX`;
}

function buildSystemPrompt(input: RoleRunInput): string {
  const knowledge = input.knowledge.length
    ? input.knowledge
        .map((document, index) => {
          const source = document.source ? ` (${document.source})` : "";
          return `### Knowledge ${index + 1}${source}\n${document.content}`;
        })
        .join("\n\n")
    : "No external role knowledge was returned.";

  return `${input.role.systemPrompt}\n\n## VEX Run\nRun: ${input.runId}\nRole: ${input.role.name}\nWorktree: ${input.cwd}\n\n## Role Knowledge\n${knowledge}`;
}

export class PiChildRunner {
  readonly #options: PiChildRunnerOptions;

  constructor(options: PiChildRunnerOptions) {
    this.#options = options;
  }

  async run(input: RoleRunInput, signal?: AbortSignal): Promise<RoleRunResult> {
    const promptDirectory = path.join(
      input.context.runDirectory as string,
      "prompts",
    );
    await mkdir(promptDirectory, { recursive: true });
    const promptPath = path.join(promptDirectory, `${input.role.name}.md`);
    await writeFile(promptPath, `${buildSystemPrompt(input)}\n`, "utf8");

    const invocation = await resolvePiInvocation(this.#options);
    const args = [
      ...invocation.args,
      "--mode",
      "json",
      "-p",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--extension",
      this.#options.extensionPath,
      "--tools",
      input.role.tools.join(","),
      "--append-system-prompt",
      promptPath,
      `Task: ${input.task}\n\nVEX context:\n${compactContext(input.context)}`,
    ];

    return new Promise<RoleRunResult>((resolve, reject) => {
      const child = spawn(invocation.command, args, {
        cwd: input.cwd,
        env: {
          ...process.env,
          ...this.#options.environment,
          VEX_CHILD: "1",
          VEX_RUN_ID: input.runId,
          VEX_ROLE: input.role.name,
        },
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.#collect(child, input, signal).then(resolve, reject);
    });
  }

  async #collect(
    child: ChildProcess,
    input: RoleRunInput,
    signal?: AbortSignal,
  ): Promise<RoleRunResult> {
    let stdoutBuffer = "";
    let rawOutput = "";
    let stderr = "";
    let roleYield: RoleYield | undefined;
    let finalText = "";
    let aborted = false;

    const processLine = (line: string) => {
      if (!line.trim()) return;
      rawOutput += `${line}\n`;
      try {
        const event = JSON.parse(line) as {
          type?: string;
          message?: PiEventMessage;
        };
        const text = textFromMessage(event.message);
        if (
          event.type === "message_end" &&
          event.message?.role === "assistant" &&
          text
        )
          finalText = text;
        if (
          event.type === "tool_result_end" &&
          event.message?.toolName === "team_yield"
        ) {
          roleYield = parseTeamYield(text) ?? roleYield;
        }
      } catch {
        // Pi JSON mode can include diagnostics; retain them in rawOutput.
      }
    };

    if (!child.stdout || !child.stderr)
      throw new Error("Pi child process has no output streams");
    child.stdout.on("data", (data: Buffer) => {
      stdoutBuffer += data.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) processLine(line);
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });

    const abort = () => {
      aborted = true;
      child.kill("SIGTERM");
      const forceKill = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      }, 5_000);
      forceKill.unref();
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
    signal?.removeEventListener("abort", abort);
    if (stdoutBuffer.trim()) processLine(stdoutBuffer);

    const resultYield: RoleYield = roleYield ?? {
      role: input.role.name,
      status: "failed",
      summary: aborted
        ? "Pi child was aborted before returning team_yield"
        : finalText ||
          stderr.trim() ||
          `Pi child exited with code ${exitCode} without team_yield`,
      artifacts: [],
    };
    if (resultYield.role !== input.role.name) {
      resultYield.status = "failed";
      resultYield.summary = `Role mismatch: expected ${input.role.name}, received ${resultYield.role}`;
    }

    return {
      role: input.role.name,
      exitCode,
      yield: resultYield,
      stderr,
      rawOutput,
    };
  }
}
