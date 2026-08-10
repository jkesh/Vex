import { describe, expect, test } from "bun:test";
import {
  addAgentUsage,
  formatRunTokenUsage,
  initialRunTokenUsage,
  normalizeRunTokenUsage,
} from "../src/usage.js";
import { MODEL_ROLES, type RoleRuntimeConfig } from "../src/types.js";

function runtime() {
  return Object.fromEntries(
    MODEL_ROLES.map((role) => [
      role,
      {
        provider: role === "frontend" ? "anthropic" : "openai",
        model: role === "frontend"
          ? "claude-sonnet"
          : role === "backend"
            ? "gpt-coder"
            : "gpt-general",
        thinking: "medium",
        source: "agent",
      } satisfies RoleRuntimeConfig,
    ]),
  ) as Record<(typeof MODEL_ROLES)[number], RoleRuntimeConfig>;
}

describe("Token usage aggregation", () => {
  test("aggregates independent Agent, Provider, and Provider/model totals", () => {
    const usage = initialRunTokenUsage(runtime());
    addAgentUsage(usage, "backend", {
      provider: "openai",
      model: "gpt-coder",
      requests: 2,
      reportedRequests: 1,
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 20,
      reasoningTokens: 10,
      totalTokens: 140,
    });
    addAgentUsage(usage, "frontend", {
      provider: "anthropic",
      model: "claude-sonnet",
      requests: 1,
      reportedRequests: 1,
      inputTokens: 60,
      outputTokens: 15,
      cachedInputTokens: 5,
      reasoningTokens: 0,
      totalTokens: 75,
    });

    expect(usage.total).toMatchObject({
      requests: 3,
      reportedRequests: 2,
      inputTokens: 160,
      outputTokens: 55,
      totalTokens: 215,
    });
    expect(usage.agents.backend).toMatchObject({
      requests: 2,
      reportedRequests: 1,
      totalTokens: 140,
    });
    expect(usage.providers.find((entry) => entry.provider === "openai"))
      .toMatchObject({ requests: 2, reportedRequests: 1, totalTokens: 140 });
    expect(usage.providers.find((entry) => entry.provider === "anthropic"))
      .toMatchObject({ requests: 1, reportedRequests: 1, totalTokens: 75 });
    expect(
      usage.models.find(
        (entry) =>
          entry.provider === "openai" && entry.model === "gpt-coder",
      ),
    ).toMatchObject({ requests: 2, reportedRequests: 1, totalTokens: 140 });
  });

  test("marks missing Provider usage as partially reported", () => {
    const usage = initialRunTokenUsage(runtime());
    addAgentUsage(usage, "backend", {
      provider: "openai",
      model: "gpt-coder",
      requests: 2,
      reportedRequests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    });

    expect(formatRunTokenUsage(usage)).toContain("0/2 calls reported");
  });

  test("rebuilds aggregates from normalized Agent counters", () => {
    const usage = normalizeRunTokenUsage({
      total: { requests: 999, totalTokens: 999 },
      providers: [{ provider: "stale", requests: 999 }],
      models: [{ provider: "stale", model: "stale", requests: 999 }],
      agents: {
        backend: {
          provider: "openai",
          model: "gpt-coder",
          requests: 2.9,
          reportedRequests: 9,
          inputTokens: 40.7,
          outputTokens: -1,
          cachedInputTokens: Number.NaN,
          reasoningTokens: Number.POSITIVE_INFINITY,
          totalTokens: 55.4,
        },
      },
    }, runtime());

    expect(usage.total).toMatchObject({
      requests: 2,
      reportedRequests: 2,
      inputTokens: 40,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 55,
    });
    expect(usage.providers.some((entry) => entry.provider === "stale"))
      .toBe(false);
    expect(usage.models.some((entry) => entry.model === "stale")).toBe(false);
  });
});
