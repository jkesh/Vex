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
import type { RoleRunInput, RoleRunResult } from "../src/types.js";
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
  readonly git = new GitClient();

  async run(input: RoleRunInput): Promise<RoleRunResult> {
    const base = {
      role: input.role.name,
      exitCode: 0,
      stderr: "",
      rawOutput: "",
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
      return {
        ...base,
        yield: {
          role: "architect",
          status: "completed",
          summary: "implement a server module",
          artifacts: [],
          payload: { securityReview: false },
        },
      };
    }
    if (input.role.name === "backend") {
      await mkdir(path.join(input.cwd, "src"), { recursive: true });
      await writeFile(
        path.join(input.cwd, "src", "server.ts"),
        "export const ready = true;\n",
        "utf8",
      );
      await this.git.run(input.cwd, ["add", "src/server.ts"]);
      await this.git.run(input.cwd, [
        "commit",
        "-m",
        "feat: add server module",
      ]);
      return {
        ...base,
        yield: {
          role: "backend",
          status: "completed",
          summary: "server added",
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
      await mkdir(path.join(input.cwd, "tests"), { recursive: true });
      await writeFile(
        path.join(input.cwd, "tests", "server.test.ts"),
        "// focused fixture test\n",
        "utf8",
      );
      await this.git.run(input.cwd, ["add", "tests/server.test.ts"]);
      await this.git.run(input.cwd, [
        "commit",
        "-m",
        "test: cover server module",
      ]);
      return {
        ...base,
        yield: {
          role: "test-engineer",
          status: "completed",
          summary: "coverage added",
          artifacts: ["tests/server.test.ts"],
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

describe("VexOrchestrator", () => {
  test("runs fixed roles, integrates commits, and fast-forwards main", async () => {
    const root = await createRepository();
    const roles = await loadRoles(path.resolve(import.meta.dir, "../roles"));
    const git = new GitClient();
    const worktrees = new WorktreeManager(
      git,
      path.join(path.dirname(root), "worktrees"),
    );
    const store = new RunStateStore(git);
    const orchestrator = new VexOrchestrator({
      roles,
      runner: new FixtureRunner(),
      knowledge: new RoleKnowledgeClient(new NoopKnowledgeProvider()),
      worktrees,
      policy: new FileOwnershipPolicy(),
      store,
    });

    const state = await orchestrator.run(
      root,
      "add a server module",
      "fixture-run",
    );
    expect(state.status).toBe("completed");
    expect(state.phase).toBe("done");
    expect(state.changes.map((change) => change.role)).toEqual([
      "backend",
      "frontend",
      "test-engineer",
    ]);
    expect(state.worktrees).toEqual([]);
    expect(
      await readFile(path.join(root, "src", "server.ts"), "utf8"),
    ).toContain("ready = true");
    expect(
      await readFile(path.join(root, "tests", "server.test.ts"), "utf8"),
    ).toContain("focused fixture");
    expect(await git.output(root, ["status", "--porcelain"])).toBe("");
    expect((await store.latest(root))?.finalRef).toBe(state.finalRef);
  }, 20_000);
});
