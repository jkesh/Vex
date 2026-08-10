import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunStateStore } from "../src/state-store.js";
import { WorktreeManager } from "../src/worktrees.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("directory workspace mode", () => {
  test("opens and stores status outside a Git repository", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-workspace-"));
    temporaryDirectories.push(root);
    const worktrees = new WorktreeManager();
    const workspace = await worktrees.inspectWorkspace(root);

    expect(workspace).toEqual({
      root: path.resolve(root),
      kind: "directory",
      branch: "",
      head: "",
      dirty: false,
    });
    expect(await worktrees.resolveWorkspaceRoot(root)).toBe(path.resolve(root));

    const store = new RunStateStore();
    expect(await store.runDirectory(root, "sample-run")).toBe(
      path.join(root, ".vex", "runs", "sample-run"),
    );
    expect(await store.latest(root)).toBeUndefined();
  });

  test("executes through a managed snapshot and applies approved changes", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "vex-managed-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "workspace");
    await mkdir(root);
    await writeFile(path.join(root, "README.md"), "before\n", "utf8");
    const worktrees = new WorktreeManager(
      undefined,
      path.join(parent, "worktrees"),
      path.join(parent, "managed"),
    );
    const repository = await worktrees.prepareRepository(root, "managed-run");

    expect(repository.kind).toBe("directory");
    expect(repository.executionRoot).not.toBe(root);
    expect(await worktrees.git.output(repository.executionRoot, ["rev-parse", "HEAD"]))
      .toBe(repository.head);
    expect(await worktrees.inspectWorkspace(root)).toMatchObject({
      kind: "directory",
    });

    const integration = await worktrees.create(
      repository.executionRoot,
      "managed-run",
      "integrator",
      repository.head,
    );
    await writeFile(path.join(integration.path, "README.md"), "after\n", "utf8");
    await worktrees.git.run(integration.path, ["add", "README.md"]);
    await worktrees.git.run(integration.path, ["commit", "-m", "update readme"]);
    await worktrees.mergeIntoDirectory(
      root,
      repository.fingerprint!,
      integration,
      path.join(parent, "backup"),
    );

    expect(await readFile(path.join(root, "README.md"), "utf8")).toBe("after\n");
    expect(await worktrees.inspectWorkspace(root)).toMatchObject({
      kind: "directory",
    });
  });

  test("prunes only untracked dependency directories before a checkpoint", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "vex-checkpoint-"));
    temporaryDirectories.push(parent);
    const root = path.join(parent, "workspace");
    await mkdir(root);
    await writeFile(path.join(root, "README.md"), "fixture\n", "utf8");
    const worktrees = new WorktreeManager(
      undefined,
      path.join(parent, "worktrees"),
      path.join(parent, "managed"),
    );
    const repository = await worktrees.prepareRepository(root, "checkpoint-run");
    await mkdir(
      path.join(repository.executionRoot, "vendor", "node_modules"),
      { recursive: true },
    );
    await writeFile(
      path.join(repository.executionRoot, "vendor", "node_modules", "tracked.txt"),
      "tracked\n",
      "utf8",
    );
    await worktrees.git.run(repository.executionRoot, [
      "add",
      "-f",
      "vendor/node_modules/tracked.txt",
    ]);
    await worktrees.git.run(repository.executionRoot, [
      "-c",
      "user.name=VEX Test",
      "-c",
      "user.email=vex@example.test",
      "commit",
      "-m",
      "tracked dependency fixture",
    ]);
    const baseRef = await worktrees.git.output(repository.executionRoot, [
      "rev-parse",
      "HEAD",
    ]);
    const writer = await worktrees.create(
      repository.executionRoot,
      "checkpoint-run",
      "test-engineer",
      baseRef,
    );
    await mkdir(path.join(writer.path, "tests", "node_modules", "package"), {
      recursive: true,
    });
    await writeFile(
      path.join(writer.path, "tests", "node_modules", "package", "index.js"),
      "generated\n",
      "utf8",
    );
    await writeFile(path.join(writer.path, "tests", "api.test.js"), "// test\n", "utf8");

    await worktrees.checkpoint(writer, "test delivery");

    await expect(
      readFile(path.join(writer.path, "tests", "node_modules", "package", "index.js")),
    ).rejects.toThrow();
    expect(
      (await readFile(
        path.join(writer.path, "vendor", "node_modules", "tracked.txt"),
        "utf8",
      )).replaceAll("\r\n", "\n"),
    ).toBe("tracked\n");
    expect(await worktrees.changedFilesBetween(writer, baseRef)).toEqual([
      "tests/api.test.js",
    ]);
  });
});
