import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeAgentRunner, parseRoleYield } from "../src/runner.js";
import type { RoleRunInput } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function input(runDirectory: string): RoleRunInput {
  return {
    runId: "run-1",
    role: {
      name: "scout",
      description: "fixture",
      stage: "discovery",
      tools: ["read", "team_yield"],
      writes: false,
      spawns: [],
      systemPrompt: "Inspect the repository.",
      filePath: "/roles/scout.md",
    },
    task: "map the repository",
    cwd: runDirectory,
    context: { runDirectory, projectTrusted: false },
    knowledge: [],
    runtime: {
      provider: "fixture",
      model: "fixture/model",
      thinking: "low",
      source: "default",
    },
    provider: {
      id: "fixture",
      protocol: "openai-chat-completions",
      modelCatalog: "openai",
      baseUrl: "https://models.example/v1",
      apiKeyEnv: "FIXTURE_KEY",
      requiresAuth: true,
      headersEnv: {},
      sendReasoningEffort: false,
      timeoutMs: 10_000,
      maxAgentTurns: 4,
    },
  };
}

describe("native agent runner", () => {
  test("validates structural role yields", () => {
    expect(
      parseRoleYield(
        {
          role: "scout",
          status: "completed",
          summary: "mapped",
          artifacts: ["src/index.ts"],
        },
        "scout",
      ),
    ).toMatchObject({ role: "scout", status: "completed" });
    expect(parseRoleYield({ role: "worker" }, "scout")).toBeUndefined();
    expect(
      parseRoleYield(
        { role: "backend", status: "completed", summary: "wrong", artifacts: [] },
        "scout",
      ),
    ).toBeUndefined();
  });

  test("calls the configured provider directly and persists its own session", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "vex-runner-"));
    temporaryDirectories.push(runDirectory);
    let request: Record<string, unknown> | undefined;
    const authorizations: Array<string | null> = [];
    const runner = new NativeAgentRunner({
      environment: {},
      auth: {
        async getApiKey(provider) {
          expect(provider).toBe("fixture");
          return "saved-secret";
        },
      },
      fetch: async (_url, init) => {
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        authorizations.push(new Headers(init?.headers).get("authorization"));
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: "",
                  tool_calls: [
                    {
                      id: "yield-1",
                      type: "function",
                      function: {
                        name: "team_yield",
                        arguments: JSON.stringify({
                          role: "scout",
                          status: "completed",
                          summary: "mapped natively",
                          artifacts: [],
                          payload: { relevantPaths: [] },
                        }),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await runner.run(input(runDirectory));
    expect(result.exitCode).toBe(0);
    expect(result.yield.summary).toBe("mapped natively");
    expect(request?.model).toBe("fixture/model");
    expect(authorizations.at(-1)).toBe("Bearer saved-secret");
    expect(JSON.stringify(request)).toContain("team_yield");
    const session = await readFile(
      path.join(runDirectory, "sessions", "scout", "history.json"),
      "utf8",
    );
    expect(session).toContain("mapped natively");
  });

  test("executes native tools and feeds literal results back to the model", async () => {
    const runDirectory = await mkdtemp(path.join(os.tmpdir(), "vex-runner-tools-"));
    temporaryDirectories.push(runDirectory);
    await writeFile(path.join(runDirectory, "README.md"), "native evidence\n", "utf8");
    let call = 0;
    let secondRequest = "";
    const runner = new NativeAgentRunner({
      environment: { FIXTURE_KEY: "secret" },
      fetch: async (_url, init) => {
        call++;
        if (call === 2) secondRequest = String(init?.body);
        const tool = call === 1
          ? {
              id: "read-1",
              type: "function",
              function: {
                name: "read",
                arguments: JSON.stringify({ path: "README.md" }),
              },
            }
          : {
              id: "yield-2",
              type: "function",
              function: {
                name: "team_yield",
                arguments: JSON.stringify({
                  role: "scout",
                  status: "completed",
                  summary: "used native evidence",
                  artifacts: ["README.md"],
                }),
              },
            };
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "", tool_calls: [tool] } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const result = await runner.run(input(runDirectory));
    expect(result.exitCode).toBe(0);
    expect(call).toBe(2);
    expect(secondRequest).toContain("native evidence");
    expect(result.rawOutput).toContain('"name":"read"');
  });
});
