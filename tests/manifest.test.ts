import { describe, expect, test } from "bun:test";
import { manifestFromArchitect, readyImplementationRoles } from "../src/manifest.js";
import type { RoleRunResult } from "../src/types.js";

function architect(payload: unknown): RoleRunResult {
  return {
    role: "architect",
    exitCode: 0,
    stderr: "",
    rawOutput: "",
    yield: {
      role: "architect",
      status: "completed",
      summary: "planned",
      artifacts: [],
      payload,
    },
  };
}

describe("execution manifest", () => {
  test("makes only dependency-ready implementation roles runnable", () => {
    const manifest = manifestFromArchitect(
      "task",
      architect({
        assignments: [
          { role: "backend", dependencies: [], ownedPaths: ["src/api/**"] },
          {
            role: "frontend",
            dependencies: ["backend"],
            ownedPaths: ["src/ui/**"],
          },
          {
            role: "test-engineer",
            dependencies: ["backend", "frontend"],
            ownedPaths: ["tests/**"],
          },
        ],
      }),
    );
    expect(
      readyImplementationRoles(
        manifest,
        new Set(["backend", "frontend"]),
        new Set(),
      ),
    ).toEqual(["backend"]);
    expect(
      readyImplementationRoles(
        manifest,
        new Set(["frontend"]),
        new Set(["backend"]),
      ),
    ).toEqual(["frontend"]);
  });

  test("rejects cycles and paths outside the repository", () => {
    expect(() =>
      manifestFromArchitect(
        "task",
        architect({
          assignments: [
            { role: "backend", dependencies: ["frontend"] },
            { role: "frontend", dependencies: ["backend"] },
          ],
        }),
      ),
    ).toThrow("dependency cycle");
    expect(() =>
      manifestFromArchitect(
        "task",
        architect({
          assignments: [{ role: "backend", ownedPaths: ["../outside"] }],
        }),
      ),
    ).toThrow("unsafe allowed path");
  });

  test("rejects unknown roles and overlapping ownership", () => {
    expect(() =>
      manifestFromArchitect(
        "task",
        architect({ assignments: [{ role: "general-worker" }] }),
      ),
    ).toThrow("unknown role");
    expect(() =>
      manifestFromArchitect(
        "task",
        architect({
          assignments: [
            { role: "backend", ownedPaths: ["src/**"] },
            { role: "frontend", ownedPaths: ["src/ui/**"] },
          ],
        }),
      ),
    ).toThrow("ownership overlaps");
  });
});
