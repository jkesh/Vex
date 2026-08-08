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
});
