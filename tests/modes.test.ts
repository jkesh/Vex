import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  classifyWorkMode,
  NativeConversationClient,
  VexModeService,
  type ConversationFetchLike,
} from "../src/modes.js";
import {
  MODEL_ROLES,
  type ProviderRuntimeConfig,
  type ResolvedVexConfig,
  type RoleDefinition,
  type RoleRunInput,
  type RoleRunResult,
} from "../src/types.js";

const provider: ProviderRuntimeConfig = {
  id: "fixture",
  protocol: "openai-chat-completions",
  modelCatalog: "openai",
  baseUrl: "https://models.example/v1",
  apiKeyEnv: "FIXTURE_KEY",
  requiresAuth: true,
  headersEnv: {},
  sendReasoningEffort: false,
  timeoutMs: 10_000,
  maxAgentTurns: 10,
};

const configuration: ResolvedVexConfig = {
  maxParallelWriters: 2,
  maxRepairAttempts: 2,
  projectCommands: [],
  defaultProvider: "fixture",
  provider,
  providers: { fixture: provider },
  agents: Object.fromEntries(
    MODEL_ROLES.map((role) => [
      role,
      {
        provider: "fixture",
        model: `${role}-model`,
        thinking: "medium",
        source: "default",
      },
    ]),
  ) as ResolvedVexConfig["agents"],
  sources: ["fixture"],
};

function role(name: "scout" | "reviewer"): RoleDefinition {
  return {
    name,
    description: name,
    stage: name === "scout" ? "discovery" : "review",
    tools: ["read", "ls", "find", "grep", "bash", "team_yield"],
    writes: false,
    spawns: [],
    systemPrompt: `${name} system`,
    filePath: `${name}.md`,
  };
}

function usage(model: string) {
  return {
    provider: "fixture",
    model,
    requests: 1,
    reportedRequests: 1,
    inputTokens: 20,
    outputTokens: 10,
    cachedInputTokens: 2,
    reasoningTokens: 1,
    totalTokens: 30,
  };
}

function reviewerResult(): RoleRunResult {
  return {
    role: "reviewer",
    exitCode: 0,
    stderr: "",
    rawOutput: "review log",
    usage: usage("reviewer-model"),
    yield: {
      role: "reviewer",
      status: "completed",
      summary: "one issue",
      artifacts: [],
      payload: {
        summary: "Architecture needs one correction.",
        findings: [{
          priority: 1,
          category: "correctness",
          title: "Unsafe fallback",
          explanation: "The fallback hides provider failures.",
          file: "src/index.ts",
          line: 12,
        }],
        recommendations: ["Make fallback state explicit."],
      },
    },
  };
}

describe("semantic work modes", () => {
  test("routes clear conversational, review, and implementation intents", () => {
    expect(classifyWorkMode("你好").mode).toBe("chat");
    expect(classifyWorkMode("为什么多 Agent 需要隔离工作区？").mode).toBe("chat");
    expect(classifyWorkMode("只做技术评审，不要修改任何代码")).toMatchObject({
      mode: "review",
      confidence: 0.99,
    });
    expect(classifyWorkMode("评审当前项目的认证架构和风险").mode).toBe("review");
    expect(classifyWorkMode("只审查当前代码仓库，不要修改").mode).toBe(
      "code-review",
    );
    expect(classifyWorkMode("Please code review this repository").mode).toBe(
      "code-review",
    );
    expect(classifyWorkMode("帮我看看这个项目的错误处理").mode).toBe("review");
    expect(classifyWorkMode("解释一下当前项目的模式路由").mode).toBe("review");
    expect(classifyWorkMode("实现登录页面并补充回归测试").mode).toBe(
      "implement",
    );
    expect(classifyWorkMode("检查登录流程并修复发现的问题").mode).toBe(
      "implement",
    );
    expect(classifyWorkMode("How should I fix this bug?").mode).toBe("chat");
    expect(classifyWorkMode("Please fix the authentication bug").mode).toBe(
      "implement",
    );
    expect(classifyWorkMode("Review the auth code and fix its fallback").mode)
      .toBe("implement");
    expect(classifyWorkMode("代码审查并修复发现的问题").mode).toBe("implement");
  });

  test("keeps short continuation prompts in the previous session mode", async () => {
    const service = new VexModeService({
      roles: new Map(),
      runner: { async run() { throw new Error("not used"); } },
      config: { async resolve() { return configuration; } },
      worktrees: {
        async inspectWorkspace() {
          return {
            root: "D:\\workspace",
            kind: "directory" as const,
            branch: "",
            head: "",
            dirty: false,
          };
        },
      },
    });

    expect((await service.decide("D:\\workspace", "fix it", "implement")).mode)
      .toBe("implement");
    expect((await service.decide("D:\\workspace", "继续", "auto"))).toMatchObject({
      mode: "implement",
      confidence: 0.92,
    });
  });

  test("keeps chat history in memory and sends no repository tools", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let reply = 0;
    const fetch: ConversationFetchLike = async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      reply += 1;
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: `answer-${reply}` } }],
        }),
        { status: 200 },
      );
    };
    const client = new NativeConversationClient({
      fetch,
      environment: {},
      auth: { async getApiKey() { return "secret"; } },
    });
    const runtime = configuration.agents.architect;

    expect(await client.chat("workspace", "first", provider, runtime)).toBe(
      "answer-1",
    );
    expect(await client.chat("workspace", "second", provider, runtime)).toBe(
      "answer-2",
    );

    expect(requests[0]).not.toHaveProperty("tools");
    expect(requests[1]).not.toHaveProperty("tools");
    expect(requests[1]!.messages).toEqual(
      expect.arrayContaining([
        { role: "user", content: "first" },
        { role: "assistant", content: "answer-1" },
        { role: "user", content: "second" },
      ]),
    );
  });

  test("runs technical review with read-only Scout and Reviewer tools", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vex-modes-"));
    const inputs: RoleRunInput[] = [];
    const roles = new Map([
      ["scout" as const, role("scout")],
      ["reviewer" as const, role("reviewer")],
    ]);
    const runner = {
      async run(input: RoleRunInput): Promise<RoleRunResult> {
        inputs.push(input);
        if (input.role.name === "scout") {
          return {
            role: "scout",
            exitCode: 0,
            stderr: "",
            rawOutput: "scout log",
            usage: usage("scout-model"),
            yield: {
              role: "scout",
              status: "completed",
              summary: "mapped",
              artifacts: [],
              payload: {
                repositorySummary: "fixture repository",
                relevantPaths: ["src/index.ts"],
                constraints: [],
                risks: [],
              },
            },
          };
        }
        return reviewerResult();
      },
    };

    try {
      const service = new VexModeService({
        roles,
        runner,
        config: { async resolve() { return configuration; } },
        worktrees: {
          async inspectWorkspace() {
            return {
              root: temporaryRoot,
              kind: "directory" as const,
              branch: "",
              head: "",
              dirty: false,
            };
          },
        },
        homeDirectory: temporaryRoot,
      });
      const report = await service.review(temporaryRoot, "review architecture");

      expect(inputs.map((input) => input.role.name)).toEqual([
        "scout",
        "reviewer",
      ]);
      for (const input of inputs) {
        expect(input.role.tools).toEqual([
          "read",
          "ls",
          "find",
          "grep",
          "team_yield",
        ]);
        expect(input.role.tools).not.toContain("bash");
        expect(input.role.writes).toBe(false);
      }
      expect(report.findings[0]).toMatchObject({
        priority: 1,
        title: "Unsafe fallback",
        file: "src/index.ts",
        line: 12,
      });
      expect(report.usage.total).toMatchObject({
        requests: 2,
        reportedRequests: 2,
        totalTokens: 60,
      });
      expect(report.usage.agents.scout.totalTokens).toBe(30);
      expect(report.usage.agents.reviewer.totalTokens).toBe(30);
      expect(
        JSON.parse(
          await readFile(path.join(path.dirname(report.artifactPath), "usage.json"), "utf8"),
        ),
      ).toMatchObject({ total: { requests: 2, totalTokens: 60 } });
      expect(JSON.parse(await readFile(report.artifactPath, "utf8"))).toMatchObject({
        mode: "technical-review",
        id: report.id,
        summary: "Architecture needs one correction.",
      });
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("runs built-in code review with only the read-only Reviewer", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vex-code-review-"));
    const inputs: RoleRunInput[] = [];
    const runner = {
      async run(input: RoleRunInput): Promise<RoleRunResult> {
        inputs.push(input);
        return reviewerResult();
      },
    };

    try {
      const service = new VexModeService({
        roles: new Map([["reviewer" as const, role("reviewer")]]),
        runner,
        config: { async resolve() { return configuration; } },
        worktrees: {
          async inspectWorkspace() {
            return {
              root: temporaryRoot,
              kind: "directory" as const,
              branch: "",
              head: "",
              dirty: false,
            };
          },
        },
        homeDirectory: temporaryRoot,
      });
      const report = await service.codeReview(
        temporaryRoot,
        "review repository code",
      );

      expect(inputs.map((input) => input.role.name)).toEqual(["reviewer"]);
      expect(inputs[0]!.role.tools).toEqual([
        "read",
        "ls",
        "find",
        "grep",
        "team_yield",
      ]);
      expect(inputs[0]!.role.writes).toBe(false);
      expect(inputs[0]!.context).toMatchObject({ mode: "code-review" });
      expect(inputs[0]!.context).not.toHaveProperty("scout");
      expect(inputs[0]!.role.systemPrompt).toContain("only Agent");
      expect(report).toMatchObject({
        mode: "code-review",
        provider: "fixture",
        model: "reviewer-model",
        usage: { total: { requests: 1, totalTokens: 30 } },
      });
      expect(path.basename(report.artifactPath)).toBe("code-review.json");
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
