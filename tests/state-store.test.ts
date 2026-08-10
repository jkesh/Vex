import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RunStateStore } from "../src/state-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("run state persistence", () => {
  test("migrates schema 5 Agent states with lifecycle timestamps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-state-"));
    temporaryDirectories.push(root);
    const store = new RunStateStore();
    const runDirectory = await store.runDirectory(root, "legacy-run");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      path.join(runDirectory, "state.json"),
      `${JSON.stringify({
        schemaVersion: 5,
        id: "legacy-run",
        task: "fixture",
        root,
        executionRoot: root,
        workspaceKind: "directory",
        baseBranch: "workspace",
        baseRef: "fixture",
        status: "running",
        phase: "implementation",
        updatedAt: "2026-01-01T00:00:05.000Z",
        roles: {
          backend: {
            status: "running",
            attempts: 2,
            startedAt: "2026-01-01T00:00:03.000Z",
          },
        },
      }, null, 2)}\n`,
      "utf8",
    );

    const state = await store.load(root, "legacy-run");
    expect(state.schemaVersion).toBe(7);
    expect(state.roles.backend).toMatchObject({
      status: "running",
      attempts: 2,
      statusChangedAt: "2026-01-01T00:00:03.000Z",
    });
    expect(state.roles.frontend).toMatchObject({
      status: "pending",
      attempts: 0,
      statusChangedAt: "2026-01-01T00:00:05.000Z",
    });
    expect(state.events.at(-1)).toMatchObject({
      type: "state-migrated",
      message: "Loaded legacy VEX schema 5",
    });
  });

  test("migrates schema 6 runs with zeroed schema 7 usage", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-state-usage-"));
    temporaryDirectories.push(root);
    const store = new RunStateStore();
    const runDirectory = await store.runDirectory(root, "schema-6-run");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(
      path.join(runDirectory, "state.json"),
      `${JSON.stringify({
        schemaVersion: 6,
        id: "schema-6-run",
        task: "fixture",
        root,
        executionRoot: root,
        workspaceKind: "directory",
        baseBranch: "workspace",
        baseRef: "fixture",
        status: "completed",
        phase: "done",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:05.000Z",
        roles: {},
      }, null, 2)}\n`,
      "utf8",
    );

    const state = await store.load(root, "schema-6-run");
    expect(state.schemaVersion).toBe(7);
    expect(state.usage.total).toMatchObject({
      requests: 0,
      reportedRequests: 0,
      totalTokens: 0,
    });
    expect(state.usage.providers).toEqual([
      expect.objectContaining({ provider: "openai", requests: 0 }),
    ]);
    expect(state.events.at(-1)).toMatchObject({
      type: "state-migrated",
      message: "Loaded legacy VEX schema 6",
    });
  });

  test("retries transient Windows locks while replacing an atomic artifact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vex-state-retry-"));
    temporaryDirectories.push(root);
    let renameCalls = 0;
    const store = new RunStateStore(undefined, "vex", async (source, target) => {
      renameCalls += 1;
      if (renameCalls < 3) {
        const error = new Error("fixture file lock") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
      await rename(source, target);
    });

    const artifact = await store.writeArtifact(root, "retry-run", "proof.json", {
      persisted: true,
    });

    expect(renameCalls).toBe(3);
    expect(JSON.parse(await readFile(artifact, "utf8"))).toEqual({ persisted: true });
  });
});
