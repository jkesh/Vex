import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { NativeAgentToolExecutor, toolDefinitions } from "./agent-tools.js";
import { vexFetch } from "./http-client.js";
import {
  completeProvider,
  type ProviderAuthResolver,
  type ProviderFetchLike,
  type ProviderMessage,
} from "./provider-transport.js";
import {
  MODEL_ROLES,
  type RoleRunInput,
  type RoleRunResult,
  type RoleYield,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compactContext(
  value: Record<string, unknown>,
  maxCharacters = 32_000,
): string {
  const json = JSON.stringify(value, null, 2);
  return json.length <= maxCharacters
    ? json
    : `${json.slice(0, maxCharacters)}\n... context truncated by VEX`;
}

function systemPrompt(input: RoleRunInput): string {
  const knowledge = input.knowledge.length
    ? input.knowledge
        .map((document, index) => {
          const source = document.source ? ` (${document.source})` : "";
          return `### Knowledge ${index + 1}${source}\n${document.content}`;
        })
        .join("\n\n")
    : "No external role knowledge was returned.";
  return `${input.role.systemPrompt}\n\n## VEX Runtime\nRun: ${input.runId}\nRole: ${input.role.name}\nModel: ${input.runtime.model}\nThinking: ${input.runtime.thinking}\nWorktree: ${input.cwd}\n\n## Role Knowledge\n${knowledge}\n\nYou are running inside VEX's native agent runtime. Use only the supplied tools. Never invent tool results. Finish exactly once with team_yield.`;
}

function userPrompt(input: RoleRunInput): string {
  return `Task: ${input.task}\n\nVEX context:\n${compactContext(input.context)}`;
}

export function parseRoleYield(
  value: unknown,
  expectedRole?: RoleRunInput["role"]["name"],
): RoleYield | undefined {
  if (!isRecord(value)) return undefined;
  const role = value.role;
  const status = value.status;
  if (
    typeof role !== "string" ||
    !MODEL_ROLES.includes(role as RoleYield["role"]) ||
    (expectedRole && role !== expectedRole) ||
    typeof status !== "string" ||
    !["completed", "skipped", "blocked", "failed"].includes(status) ||
    typeof value.summary !== "string" ||
    !value.summary.trim() ||
    !Array.isArray(value.artifacts) ||
    value.artifacts.some((artifact) => typeof artifact !== "string")
  ) {
    return undefined;
  }
  return {
    role: role as RoleYield["role"],
    status: status as RoleYield["status"],
    summary: value.summary,
    artifacts: value.artifacts as string[],
    ...(value.payload !== undefined ? { payload: value.payload } : {}),
  };
}

async function loadSession(filePath: string): Promise<ProviderMessage[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as ProviderMessage[]) : [];
  } catch {
    return [];
  }
}

async function saveSession(
  filePath: string,
  messages: ProviderMessage[],
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  await writeFile(temporary, `${JSON.stringify(messages, null, 2)}\n`, "utf8");
  await rename(temporary, filePath);
}

function compactSession(messages: ProviderMessage[], limit = 80): void {
  if (messages.length <= limit + 1) return;
  const system = messages[0]!;
  const tail = messages.slice(-limit);
  while (tail[0]?.role === "tool") tail.shift();
  messages.splice(
    0,
    messages.length,
    system,
    {
      role: "user",
      content:
        "VEX truncated older session messages. Continue from the recent tool history and current assignment context.",
    },
    ...tail,
  );
}

function failure(
  input: RoleRunInput,
  summary: string,
  rawOutput: string,
): RoleRunResult {
  return {
    role: input.role.name,
    exitCode: 1,
    yield: {
      role: input.role.name,
      status: "failed",
      summary,
      artifacts: [],
    },
    stderr: summary,
    rawOutput,
  };
}

export interface NativeAgentRunnerOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: FetchLike;
  tools?: NativeAgentToolExecutor;
  auth?: ProviderAuthResolver;
}

export type FetchLike = ProviderFetchLike;

export class NativeAgentRunner {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #fetch: FetchLike;
  readonly #tools: NativeAgentToolExecutor;
  readonly #auth?: NativeAgentRunnerOptions["auth"];

  constructor(options: NativeAgentRunnerOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#fetch = options.fetch ?? vexFetch;
    this.#tools = options.tools ?? new NativeAgentToolExecutor();
    this.#auth = options.auth;
  }

  async run(input: RoleRunInput, signal?: AbortSignal): Promise<RoleRunResult> {
    const runDirectory = input.context.runDirectory;
    if (typeof runDirectory !== "string" || !runDirectory) {
      throw new Error("Role context is missing runDirectory");
    }
    const promptDirectory = path.join(runDirectory, "prompts");
    await mkdir(promptDirectory, { recursive: true });
    await writeFile(
      path.join(promptDirectory, `${input.role.name}.md`),
      `${systemPrompt(input)}\n\n${userPrompt(input)}\n`,
      "utf8",
    );
    const sessionPath = path.join(
      runDirectory,
      "sessions",
      input.role.name,
      "history.json",
    );
    const messages = input.resumeSession ? await loadSession(sessionPath) : [];
    if (messages.length === 0) {
      messages.push({ role: "system", content: systemPrompt(input) });
    } else {
      messages[0] = { role: "system", content: systemPrompt(input) };
    }
    messages.push({ role: "user", content: userPrompt(input) });
    let rawOutput = "";
    try {
      for (let turn = 1; turn <= input.provider.maxAgentTurns; turn++) {
        if (signal?.aborted) throw new DOMException("VEX run aborted", "AbortError");
        compactSession(messages);
        const completion = await completeProvider({
          provider: input.provider,
          model: input.runtime.model,
          thinking: input.runtime.thinking,
          messages,
          tools: toolDefinitions(input.role.tools),
          environment: this.#environment,
          fetch: this.#fetch,
          ...(this.#auth ? { auth: this.#auth } : {}),
          ...(signal ? { signal } : {}),
          sessionId: input.runId,
        });
        const content = completion.content;
        const calls = completion.toolCalls;
        const assistant: ProviderMessage = {
          role: "assistant",
          content: content || null,
          ...(calls.length ? { tool_calls: calls } : {}),
          ...(completion.responseItems
            ? { response_items: completion.responseItems }
            : {}),
        };
        messages.push(assistant);
        rawOutput += `${JSON.stringify({ turn, type: "assistant", content, tools: calls.map((call) => call.function.name) })}\n`;
        if (calls.length === 0) {
          messages.push({
            role: "user",
            content:
              "Continue using the available tools. You must finish by calling team_yield with a structured result.",
          });
          await saveSession(sessionPath, messages);
          continue;
        }
        for (const call of calls) {
          let args: unknown;
          try {
            args = JSON.parse(call.function.arguments);
          } catch {
            args = {};
          }
          if (call.function.name === "team_yield") {
            const roleYield = parseRoleYield(args, input.role.name);
            if (!roleYield) {
              messages.push({
                role: "tool",
                tool_call_id: call.id,
                content: "ERROR: invalid team_yield payload or role mismatch",
              });
              continue;
            }
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: "VEX accepted the role result.",
            });
            await saveSession(sessionPath, messages);
            rawOutput += `${JSON.stringify({ turn, type: "yield", value: roleYield })}\n`;
            return {
              role: input.role.name,
              exitCode: 0,
              yield: roleYield,
              stderr: "",
              rawOutput,
            };
          }
          let toolResult: string;
          try {
            toolResult = await this.#tools.execute(
              call.function.name,
              args,
              input,
              signal,
            );
          } catch (error) {
            toolResult = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
          }
          messages.push({
            role: "tool",
            tool_call_id: call.id,
            content: toolResult,
          });
          rawOutput += `${JSON.stringify({ turn, type: "tool", name: call.function.name, result: toolResult.slice(0, 2_000) })}\n`;
        }
        await saveSession(sessionPath, messages);
      }
      return failure(
        input,
        `Agent exceeded ${input.provider.maxAgentTurns} turns without team_yield`,
        rawOutput,
      );
    } catch (error) {
      if (signal?.aborted) throw new DOMException("VEX run aborted", "AbortError");
      return failure(
        input,
        error instanceof Error ? error.message : String(error),
        rawOutput,
      );
    }
  }
}
