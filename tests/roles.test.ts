import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { loadRoles } from "../src/roles.js";
import { MODEL_ROLES } from "../src/types.js";

describe("fixed role registry", () => {
  test("loads every fixed role and disables role-level spawning", async () => {
    const roles = await loadRoles(
      fileURLToPath(new URL("../roles", import.meta.url)),
    );
    expect([...roles.keys()].sort()).toEqual([...MODEL_ROLES].sort());
    for (const role of roles.values()) expect(role.spawns).toEqual([]);
  });

  test("grants write tools only to writer roles", async () => {
    const roles = await loadRoles(
      fileURLToPath(new URL("../roles", import.meta.url)),
    );
    for (const [name, role] of roles) {
      const hasWriteTool =
        role.tools.includes("write") || role.tools.includes("edit");
      expect(hasWriteTool).toBe(
        ["backend", "frontend", "test-engineer"].includes(name),
      );
    }
  });

  test("defines the Architect dependency vocabulary unambiguously", async () => {
    const roles = await loadRoles(
      fileURLToPath(new URL("../roles", import.meta.url)),
    );
    const prompt = roles.get("architect")!.systemPrompt;
    expect(prompt).toContain(
      "`dependencies` and `integrationOrder` contain fixed role names",
    );
    expect(prompt).toContain('"dependencies": ["backend", "frontend"]');
    expect(prompt).toContain(
      '"integrationOrder": ["backend", "frontend", "test-engineer"]',
    );
    expect(prompt).toContain("Never require downloading a browser binary");
  });

  test("keeps writer verification bounded and generated dependencies untracked", async () => {
    const roles = await loadRoles(
      fileURLToPath(new URL("../roles", import.meta.url)),
    );
    for (const name of ["backend", "frontend", "test-engineer"] as const) {
      const prompt = roles.get(name)!.systemPrompt;
      expect(prompt).toContain("Never start a background or persistent server");
      expect(prompt).toContain("Use only worktree-relative paths");
      expect(prompt).toContain("preserve the exact `assignment.allowedPaths` prefix");
      expect(prompt).toContain("Never copy or move files");
      expect(prompt).toContain("`node_modules`, caches, coverage, and build output");
      expect(prompt).toContain("VEX owns Git mutations");
      expect(prompt).toContain("Run package-manager commands only from a directory containing its package manifest");
      expect(prompt).toContain("delete temporary verification files");
      expect(prompt).toContain("never leave generated dependencies or caches");
      expect(roles.get(name)!.tools).toContain("delete");
    }
    expect(roles.get("test-engineer")!.systemPrompt).toContain(
      "never download browser binaries",
    );
    expect(roles.get("test-engineer")!.systemPrompt).toContain("prefer `node:test`");
    expect(roles.get("test-engineer")!.systemPrompt).toContain(
      "snapshot its exact original bytes",
    );
    expect(roles.get("test-engineer")!.systemPrompt).toContain(
      "Immediately before `team_yield`, run `git status --short`",
    );
  });
});
