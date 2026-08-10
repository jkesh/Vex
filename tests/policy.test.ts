import { describe, expect, test } from "bun:test";
import { FileOwnershipPolicy } from "../src/policy.js";

describe("FileOwnershipPolicy", () => {
  const policy = new FileOwnershipPolicy();

  test("blocks protected and cross-domain paths", () => {
    const violations = policy.check(
      "frontend",
      ["server/api/users.ts", ".env.local"],
      new Map(),
    );
    expect(violations.map((item) => item.rule)).toEqual([
      "role-boundary",
      "protected-path",
    ]);
  });

  test("blocks two writer roles from owning the same file", () => {
    const violations = policy.check(
      "frontend",
      ["package.json"],
      new Map([["package.json", "backend"]]),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("cross-role-conflict");
  });

  test("allows test-engineer changes under test paths", () => {
    expect(
      policy.check(
        "test-engineer",
        ["tests/api.test.ts", "src/__tests__/unit.spec.ts"],
        new Map(),
      ),
    ).toEqual([]);
  });

  test("enforces manifest-owned paths including glob patterns", () => {
    expect(
      policy.check(
        "backend",
        ["src/server.ts"],
        new Map(),
        ["src/**"],
      ),
    ).toEqual([]);
    expect(
      policy.check(
        "backend",
        ["package.json"],
        new Map(),
        ["src/**"],
      )[0]?.rule,
    ).toBe("assignment-boundary");
  });

  test("treats explicit manifest ownership as authoritative", () => {
    expect(
      policy.check(
        "frontend",
        ["frontend/src/api/client.ts"],
        new Map(),
        ["frontend/**"],
      ),
    ).toEqual([]);
  });
});
