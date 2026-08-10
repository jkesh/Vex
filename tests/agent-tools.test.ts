import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { NativeAgentToolExecutor } from "../src/agent-tools.js";
import type { RoleRunInput } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(writes = true): Promise<RoleRunInput> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "vex-tools-"));
  temporaryDirectories.push(cwd);
  return {
    runId: "tool-run",
    role: {
      name: writes ? "backend" : "scout",
      description: "fixture",
      stage: writes ? "implementation" : "discovery",
      tools: writes
        ? ["read", "bash", "edit", "write", "delete", "team_yield"]
        : ["read", "bash", "team_yield"],
      writes,
      spawns: [],
      systemPrompt: "fixture",
      filePath: "/roles/fixture.md",
    },
    task: "fixture",
    cwd,
    context: {
      runDirectory: path.join(cwd, ".state"),
      assignment: { allowedPaths: ["src/**"] },
    },
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
      baseUrl: "http://localhost/v1",
      apiKeyEnv: "VEX_TEST_KEY",
      requiresAuth: false,
      headersEnv: {},
      sendReasoningEffort: false,
      timeoutMs: 10_000,
      maxAgentTurns: 5,
    },
  };
}

describe("native agent tools", () => {
  test("writes and edits only inside manifest allowed paths", async () => {
    const input = await fixture();
    const tools = new NativeAgentToolExecutor();
    await tools.execute(
      "write",
      { path: "src/server.ts", content: "export const ready = false;\n" },
      input,
    );
    await tools.execute(
      "edit",
      {
        path: "src/server.ts",
        oldText: "ready = false",
        newText: "ready = true",
      },
      input,
    );
    expect(await readFile(path.join(input.cwd, "src/server.ts"), "utf8")).toContain(
      "ready = true",
    );
    await expect(
      tools.execute(
        "write",
        { path: "README.md", content: "outside" },
        input,
      ),
    ).rejects.toThrow("outside this role's allowed paths");
    await expect(
      tools.execute(
        "write",
        { path: "../escape.txt", content: "outside" },
        input,
      ),
    ).rejects.toThrow("escapes the assigned worktree");
  });

  test("keeps read-only roles and shell commands non-mutating", async () => {
    const input = await fixture(false);
    const tools = new NativeAgentToolExecutor();
    await writeFile(path.join(input.cwd, ".env"), "SECRET=value\n", "utf8");
    await expect(
      tools.execute("write", { path: "src/file.ts", content: "bad" }, input),
    ).rejects.toThrow("not available");
    await expect(
      tools.execute("bash", { command: "echo bad > src/file.ts" }, input),
    ).rejects.toThrow("direct shell file writes are blocked");
    await expect(
      tools.execute("bash", { command: "git commit -am bad" }, input),
    ).rejects.toThrow("read-only");
    await expect(
      tools.execute("read", { path: ".env" }, input),
    ).rejects.toThrow("Protected path");
    await expect(
      tools.execute("bash", { command: "curl https://example.com" }, input),
    ).rejects.toThrow("network access");
  });

  test("confines shell paths to the assigned worktree", async () => {
    const input = await fixture();
    const tools = new NativeAgentToolExecutor();
    const outside = path.join(path.dirname(input.cwd), "source-workspace");
    await expect(
      tools.execute(
        "bash",
        { command: `npm --prefix "${outside}" install` },
        input,
      ),
    ).rejects.toThrow("outside the assigned worktree");
    await expect(
      tools.execute("bash", { command: "cd .. && npm test" }, input),
    ).rejects.toThrow("cannot traverse outside the assigned worktree");
    await expect(
      tools.execute(
        "bash",
        { command: 'robocopy "backend\\backend" "." /E /MOVE' },
        input,
      ),
    ).rejects.toThrow("direct shell file writes are blocked");
    expect(
      await tools.execute(
        "bash",
        {
          command:
            'node -e "const values=[1]; console.log(values.map(value=>value+1), 2 >= 1)"',
        },
        input,
      ),
    ).toContain("exit=0");
    await expect(
      tools.execute("bash", { command: "git add -A" }, input),
    ).rejects.toThrow("VEX owns Git mutations");
    await expect(
      tools.execute("bash", { command: "npm install" }, input),
    ).rejects.toThrow("package-manager commands must run inside");
    await expect(
      tools.execute(
        "bash",
        { command: "npx vitest run --config tests/vitest.config.ts" },
        input,
      ),
    ).rejects.toThrow("package-manager commands must run inside");
    await expect(
      tools.execute("bash", { command: "bunx vitest run" }, input),
    ).rejects.toThrow("package-manager commands must run inside");
    await writeFile(
      path.join(input.cwd, "package.json"),
      '{"name":"fixture","private":true}\n',
      "utf8",
    );
    expect(
      await tools.execute("bash", { command: "npm prefix" }, input),
    ).toContain("exit=0");
  });

  test("deletes only files owned by the writer assignment", async () => {
    const input = await fixture();
    const tools = new NativeAgentToolExecutor();
    await tools.execute(
      "write",
      { path: "src/temporary.js", content: "temporary\n" },
      input,
    );
    expect(
      await tools.execute("delete", { path: "src/temporary.js" }, input),
    ).toContain("deleted src/temporary.js");
    await expect(readFile(path.join(input.cwd, "src/temporary.js"), "utf8"))
      .rejects.toThrow();
    await writeFile(path.join(input.cwd, "outside.txt"), "keep\n", "utf8");
    await expect(
      tools.execute("delete", { path: "outside.txt" }, input),
    ).rejects.toThrow("outside this role's allowed paths");
  });

  test("terminates shell commands at the Provider timeout", async () => {
    const input = await fixture();
    input.provider.timeoutMs = 1_000;
    const tools = new NativeAgentToolExecutor();
    const result = await tools.execute(
      "bash",
      { command: "node -e \"setInterval(function(){}, 1000)\"" },
      input,
    );
    expect(result).toContain("command exceeded 1000ms");
  });
});
