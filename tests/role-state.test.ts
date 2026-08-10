import { describe, expect, test } from "bun:test";
import {
  initialRoleState,
  roleStatusLabel,
  transitionRoleState,
} from "../src/role-state.js";

describe("Agent lifecycle state machine", () => {
  test("tracks not-started, waiting, working, and delivered states", () => {
    const pending = initialRoleState("2026-01-01T00:00:00.000Z");
    expect(roleStatusLabel(pending.status)).toBe("not-started");

    const waiting = transitionRoleState(pending, "waiting", {
      at: "2026-01-01T00:00:01.000Z",
      waitingFor: "backend delivery",
    });
    expect(waiting).toMatchObject({
      status: "waiting",
      waitingFor: "backend delivery",
      statusChangedAt: "2026-01-01T00:00:01.000Z",
    });
    expect(roleStatusLabel(waiting.status)).toBe("waiting");

    const working = transitionRoleState(waiting, "running", {
      at: "2026-01-01T00:00:02.000Z",
      attempts: 1,
    });
    expect(working).toMatchObject({
      status: "running",
      attempts: 1,
      startedAt: "2026-01-01T00:00:02.000Z",
    });
    expect(working.waitingFor).toBeUndefined();
    expect(roleStatusLabel(working.status)).toBe("working");

    const delivered = transitionRoleState(working, "completed", {
      at: "2026-01-01T00:00:03.000Z",
      summary: "delivery complete",
    });
    expect(delivered).toMatchObject({
      status: "completed",
      finishedAt: "2026-01-01T00:00:03.000Z",
      summary: "delivery complete",
    });
    expect(roleStatusLabel(delivered.status)).toBe("delivered");
  });

  test("rejects invalid or unexplained transitions", () => {
    const pending = initialRoleState();
    expect(() => transitionRoleState(pending, "waiting")).toThrow(
      "requires waitingFor",
    );
    const working = transitionRoleState(pending, "running");
    const delivered = transitionRoleState(working, "completed");
    expect(() => transitionRoleState(delivered, "pending")).toThrow(
      "completed -> pending",
    );
  });
});
