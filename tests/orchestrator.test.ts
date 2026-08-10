import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  NoopKnowledgeProvider,
  RoleKnowledgeClient,
} from "../src/knowledge.js";
import { VexOrchestrator } from "../src/orchestrator.js";
import { FileOwnershipPolicy } from "../src/policy.js";
import { loadRoles } from "../src/roles.js";
import { RunStateStore } from "../src/state-store.js";
import { formatRunState, VexService } from "../src/service.js";
import type {
  ModelRole,
  RoleRunInput,
  RoleRunResult,
  RoleRuntimeConfig,
} from "../src/types.js";
import { GitClient } from "../src/git.js";
import { WorktreeManager } from "../src/worktrees.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function createRepository(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vex-test-"));
  temporaryDirectories.push(directory);
  const root = path.join(directory, "repo");
  await mkdir(root);
  const git = new GitClient();
  await git.run(root, ["init", "-b", "main"]);
  await git.run(root, ["config", "user.name", "VEX Test"]);
  await git.run(root, ["config", "user.email", "vex@example.test"]);
  await writeFile(path.join(root, "README.md"), "# Fixture\n", "utf8");
  await git.run(root, ["add", "README.md"]);
  await git.run(root, ["commit", "-m", "fixture"]);
  return root;
}

class FixtureRunner {
  readonly inputs: RoleRunInput[] = [];
  architectCalls = 0;
  reviewerCalls = 0;
  testEngineerCalls = 0;

  async run(input: RoleRunInput): Promise<RoleRunResult> {
    this.inputs.push(input);
    const base = {
      role: input.role.name,
      exitCode: 0,
      stderr: "",
      rawOutput: "",
      usage: {
        provider: input.runtime.provider,
        model: input.runtime.model,
        requests: 1,
        reportedRequests: 1,
        inputTokens: 100,
        outputTokens: 25,
        cachedInputTokens: 10,
        reasoningTokens: 5,
        totalTokens: 125,
      },
    } as const;
    if (input.role.name === "scout") {
      return {
        ...base,
        yield: {
          role: "scout",
          status: "completed",
          summary: "mapped",
          artifacts: [],
          payload: {},
        },
      };
    }
    if (input.role.name === "architect") {
      const invalid = this.architectCalls++ === 0;
      if (!invalid) {
        expect(input.context.manifestValidationError).toContain(
          "ownership overlaps",
        );
      }
      return {
        ...base,
        yield: {
          role: "architect",
          status: "completed",
          summary: "implement a server module",
          artifacts: [],
          payload: {
            summary: "implement a server module",
            assignments: [
              {
                role: "backend",
                objective: "add the server module",
                ownedPaths: ["src/**"],
                dependencies: [],
              },
              {
                role: "frontend",
                objective: "no UI work",
                ownedPaths: [],
                dependencies: [],
              },
              {
                role: "test-engineer",
                objective: "cover the server module",
                ownedPaths: invalid ? ["src/**"] : ["tests/**"],
                dependencies: ["backend", "frontend"],
              },
            ],
            integrationOrder: ["backend", "frontend", "test-engineer"],
            securityReview: false,
          },
        },
      };
    }
    if (input.role.name === "backend") {
      await mkdir(path.join(input.cwd, "src"), { recursive: true });
      const repairing = typeof input.context.repairAttempt === "number";
      await writeFile(
        path.join(input.cwd, "src", "server.ts"),
        repairing
          ? 'export const ready = "repaired";\n'
          : "export const ready = true;\n",
        "utf8",
      );
      return {
        ...base,
        yield: {
          role: "backend",
          status: "completed",
          summary: repairing ? "server repaired" : "server added",
          artifacts: ["src/server.ts"],
        },
      };
    }
    if (input.role.name === "frontend") {
      return {
        ...base,
        yield: {
          role: "frontend",
          status: "skipped",
          summary: "no UI work",
          artifacts: [],
        },
      };
    }
    if (input.role.name === "test-engineer") {
      const repairing = typeof input.context.repairAttempt === "number";
      if (!repairing && this.testEngineerCalls++ === 0) {
        return {
          ...base,
          exitCode: 1,
          stderr: "terminated",
          rawOutput: '{"type":"error","message":"terminated"}\n',
          usage: {
            ...base.usage,
            reportedRequests: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
          },
          yield: {
            role: "test-engineer",
            status: "failed",
            summary: "terminated",
            artifacts: [],
          },
        };
      }
      if (repairing) {
        expect(
          await readFile(path.join(input.cwd, "src", "server.ts"), "utf8"),
        ).toContain('ready = "repaired"');
      }
      await mkdir(path.join(input.cwd, "tests"), { recursive: true });
      await writeFile(
        path.join(input.cwd, "tests", "server.test.ts"),
        repairing
          ? "// repaired fixture coverage\n"
          : "// focused fixture test\n",
        "utf8",
      );
      return {
        ...base,
        yield: {
          role: "test-engineer",
          status: "completed",
          summary: repairing ? "coverage repaired" : "coverage added",
          artifacts: ["tests/server.test.ts"],
        },
      };
    }
    if (input.role.name === "reviewer" && this.reviewerCalls++ === 0) {
      return {
        ...base,
        yield: {
          role: "reviewer",
          status: "completed",
          summary: "one repair required",
          artifacts: [],
          payload: {
            approved: false,
            summary: "one repair required",
            findings: [
              {
                owner: "backend",
                priority: 1,
                file: "src/server.ts",
                line: 1,
                title: "Harden readiness state",
                explanation: "Use the repaired readiness state in this fixture.",
              },
              {
                owner: "test-engineer",
                priority: 2,
                file: "tests/server.test.ts",
                line: 1,
                title: "Cover the repaired readiness state",
                explanation: "Verify the backend repair from the refreshed worktree.",
              },
            ],
          },
        },
      };
    }
    return {
      ...base,
      yield: {
        role: input.role.name,
        status: "completed",
        summary: "approved",
        artifacts: [],
        payload: { approved: true, findings: [], summary: "approved" },
      },
    };
  }
}

async function createHarness(root: string, runtimeBase = path.dirname(root)) {
  const roles = await loadRoles(path.resolve(import.meta.dir, "../roles"));
  const git = new GitClient();
  const worktrees = new WorktreeManager(
    git,
    path.join(runtimeBase, "worktrees"),
    path.join(runtimeBase, "managed"),
  );
  const store = new RunStateStore(git);
  const runner = new FixtureRunner();
  const provider = {
    id: "fixture",
    protocol: "openai-chat-completions" as const,
    modelCatalog: "openai" as const,
    baseUrl: "https://fixture.invalid/v1",
    apiKeyEnv: "VEX_TEST_KEY",
    requiresAuth: false,
    headersEnv: {},
    sendReasoningEffort: false,
    timeoutMs: 10_000,
    maxAgentTurns: 10,
  };
  const orchestrator = new VexOrchestrator({
    roles,
    runner,
    knowledge: new RoleKnowledgeClient(new NoopKnowledgeProvider()),
    worktrees,
    policy: new FileOwnershipPolicy(),
    store,
    config: {
      async resolve() {
        const runtime = Object.fromEntries(
          [...roles.keys()].map((role) => [
            role,
            {
              provider: "fixture",
              model: `fixture/${role}`,
              thinking: "medium" as const,
              source: "agent" as const,
            },
          ]),
        ) as Record<ModelRole, RoleRuntimeConfig>;
        return {
          maxParallelWriters: 2 as const,
          maxRepairAttempts: 2,
          projectCommands: [],
          defaultProvider: "fixture",
          provider,
          providers: { fixture: provider },
          agents: runtime,
          sources: ["fixture"],
        };
      },
    },
  });
  return { git, worktrees, store, runner, orchestrator };
}

describe("VexOrchestrator", () => {
  test("plans, waits for approval, integrates, and merges only explicitly", async () => {
    const root = await createRepository();
    const { git, worktrees, store, runner, orchestrator } = await createHarness(root);

    const planned = await orchestrator.plan(
      root,
      "add a server module",
      "fixture-run",
    );
    expect(planned.status).toBe("awaiting-confirmation");
    expect(planned.phase).toBe("approval");
    expect(planned.schemaVersion).toBe(7);
    expect(planned.provider.protocol).toBe("openai-chat-completions");
    expect(planned.manifest?.runId).toBe("fixture-run");
    expect(planned.worktrees).toEqual([]);
    expect(planned.roles.architect.attempts).toBe(2);
    expect(planned.roles.backend).toMatchObject({
      status: "waiting",
      waitingFor: "execution approval",
    });
    expect(planned.roles.reviewer.status).toBe("pending");
    expect(formatRunState(planned)).toContain(
      "backend=waiting(execution approval)#0",
    );
    expect(formatRunState(planned)).toContain("reviewer=not-started#0");
    expect(
      planned.events.some((event) => event.type === "manifest-rejected"),
    ).toBe(true);
    expect(
      planned.events.some((event) => event.type === "role-waiting"),
    ).toBe(true);
    const runDirectory = await store.runDirectory(root, "fixture-run");
    expect(
      JSON.parse(
        await readFile(path.join(runDirectory, "manifest.json"), "utf8"),
      ).baseCommit,
    ).toBe(planned.baseRef);
    expect(
      Object.keys(
        JSON.parse(
          await readFile(
            path.join(runDirectory, "role-definition-hashes.json"),
            "utf8",
          ),
        ),
      ),
    ).toHaveLength(7);
    expect(
      (await git.run(root, ["cat-file", "-e", "HEAD:src/server.ts"], true))
        .exitCode,
    ).not.toBe(0);

    const ready = await orchestrator.execute(root, "fixture-run");
    expect(ready.status).toBe("awaiting-merge");
    expect(ready.phase).toBe("ready-to-merge");
    expect(ready.configurationSources).toEqual(["fixture"]);
    expect(ready.changes.map((change) => change.role)).toEqual([
      "backend",
      "frontend",
      "test-engineer",
      "backend",
      "test-engineer",
    ]);
    expect(ready.worktrees.length).toBeGreaterThan(0);
    expect(ready.reviewCycles).toHaveLength(2);
    expect(ready.findings).toEqual([]);
    expect(formatRunState(ready)).toContain("backend=delivered#2");
    expect(formatRunState(ready)).toContain("test-engineer=delivered#3");
    expect(ready.roles["test-engineer"].attempts).toBe(3);
    expect(ready.usage.agents["test-engineer"]).toMatchObject({
      provider: "fixture",
      model: "fixture/test-engineer",
      requests: 3,
      reportedRequests: 2,
      totalTokens: 250,
    });
    expect(ready.usage.total.requests).toBe(runner.inputs.length);
    expect(
      ready.usage.models.reduce((total, model) => total + model.requests, 0),
    ).toBe(runner.inputs.length);
    expect(
      ready.usage.models.find(
        (model) => model.model === "fixture/test-engineer",
      ),
    ).toMatchObject({
      provider: "fixture",
      requests: 3,
      reportedRequests: 2,
      totalTokens: 250,
    });
    expect(
      ready.events.some(
        (event) =>
          event.type === "role-retry-scheduled" &&
          event.role === "test-engineer" &&
          event.message.includes("transient Provider retry 1/2"),
      ),
    ).toBe(true);
    expect(
      runner.inputs.filter(
        (input) =>
          input.role.name === "test-engineer" &&
          typeof input.context.repairAttempt !== "number",
      ),
    ).toHaveLength(2);
    expect(
      runner.inputs.filter((input) => input.role.name === "backend"),
    ).toHaveLength(2);
    expect(
      runner.inputs.find(
        (input) =>
          input.role.name === "backend" && input.resumeSession === true,
      ),
    ).toBeDefined();
    expect(
      runner.inputs
        .filter((input) => input.role.name === "reviewer")
        .every((input) => input.resumeSession !== true),
    ).toBe(true);
    expect(
      (await git.run(root, ["cat-file", "-e", "HEAD:src/server.ts"], true))
        .exitCode,
    ).not.toBe(0);

    const service = new VexService(orchestrator, store, worktrees);
    expect(await service.abortRun(root, "fixture-run")).toBeUndefined();
    expect((await store.load(root, "fixture-run")).status).toBe(
      "awaiting-merge",
    );

    const state = await orchestrator.merge(root, "fixture-run");
    expect(state.status).toBe("completed");
    expect(state.phase).toBe("done");
    expect(state.worktrees).toEqual([]);
    expect(
      await readFile(path.join(root, "src", "server.ts"), "utf8"),
    ).toContain('ready = "repaired"');
    expect(
      await readFile(path.join(root, "tests", "server.test.ts"), "utf8"),
    ).toContain("repaired fixture coverage");
    expect(await git.output(root, ["status", "--porcelain"])).toBe("");
    expect((await store.latest(root))?.finalRef).toBe(state.finalRef);
    expect(
      runner.inputs.every(
        (input) => input.runtime.model === `fixture/${input.role.name}`,
      ),
    ).toBe(true);
  }, 60_000);

  test("runs the complete workflow in a directory without creating .git", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "vex-directory-run-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "workspace");
    await mkdir(root);
    await writeFile(path.join(root, "README.md"), "# Directory fixture\n", "utf8");
    const { worktrees, orchestrator } = await createHarness(root, parent);

    const planned = await orchestrator.plan(
      root,
      "add a server module",
      "directory-run",
    );
    expect(planned.workspaceKind).toBe("directory");
    expect(planned.executionRoot).not.toBe(root);
    expect(await worktrees.inspectWorkspace(root)).toMatchObject({
      kind: "directory",
    });

    const ready = await orchestrator.execute(root, "directory-run");
    expect(ready.status).toBe("awaiting-merge");
    await expect(readFile(path.join(root, "src", "server.ts"), "utf8"))
      .rejects.toThrow();

    const merged = await orchestrator.merge(root, "directory-run");
    expect(merged.status).toBe("completed");
    expect(await readFile(path.join(root, "src", "server.ts"), "utf8"))
      .toContain('ready = "repaired"');
    expect(await worktrees.inspectWorkspace(root)).toMatchObject({
      kind: "directory",
    });
  }, 60_000);
});
