import { describe, expect, test } from "bun:test";
import { parseTeamYield, TEAM_YIELD_MARKER } from "../src/runner.js";
import type { RoleYield } from "../src/types.js";

describe("team_yield protocol", () => {
  test("parses the last structured result marker", () => {
    const payload = {
      role: "scout",
      status: "completed",
      summary: "mapped",
      artifacts: ["src/index.ts"],
      payload: { relevantPaths: ["src/index.ts"] },
    } satisfies RoleYield;
    expect(
      parseTeamYield(
        `diagnostic\n${TEAM_YIELD_MARKER}${JSON.stringify(payload)}`,
      ),
    ).toEqual(payload);
  });

  test("ignores malformed output", () => {
    expect(parseTeamYield(`${TEAM_YIELD_MARKER}{bad json`)).toBeUndefined();
  });

  test("rejects unknown roles and statuses", () => {
    const invalid = {
      role: "worker",
      status: "done",
      summary: "bad",
      artifacts: [],
    };
    expect(
      parseTeamYield(`${TEAM_YIELD_MARKER}${JSON.stringify(invalid)}`),
    ).toBeUndefined();
  });
});
