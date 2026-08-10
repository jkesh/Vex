import {
  MODEL_ROLES,
  type AgentTokenUsage,
  type ModelRole,
  type ModelTokenUsage,
  type ProviderUsage,
  type ProviderTokenUsage,
  type RoleRuntimeConfig,
  type RunTokenUsage,
  type TokenUsage,
} from "./types.js";

const counterKeys = [
  "requests",
  "reportedRequests",
  "inputTokens",
  "outputTokens",
  "cachedInputTokens",
  "reasoningTokens",
  "totalTokens",
] as const;

function counter(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : 0;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function emptyTokenUsage(): TokenUsage {
  return {
    requests: 0,
    reportedRequests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

export function createAgentTokenUsage(
  provider: string,
  model: string,
): AgentTokenUsage {
  return { provider, model, ...emptyTokenUsage() };
}

export function normalizeTokenUsage(value: unknown): TokenUsage {
  const raw = record(value);
  const normalized = emptyTokenUsage();
  for (const key of counterKeys) normalized[key] = counter(raw[key]);
  normalized.reportedRequests = Math.min(
    normalized.reportedRequests,
    normalized.requests,
  );
  return normalized;
}

export function addTokenUsage(target: TokenUsage, value: TokenUsage): void {
  for (const key of counterKeys) target[key] += value[key];
}

export function recordProviderRequest(target: TokenUsage): void {
  target.requests += 1;
}

export function recordProviderResponse(
  target: AgentTokenUsage,
  usage?: ProviderTokenUsage,
): void {
  if (!usage) return;
  target.reportedRequests += 1;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cachedInputTokens += usage.cachedInputTokens;
  target.reasoningTokens += usage.reasoningTokens;
  target.totalTokens += usage.totalTokens;
}

function route(
  runtime: Partial<Record<ModelRole, Partial<RoleRuntimeConfig>>> | undefined,
  role: ModelRole,
): { provider: string; model: string } {
  return {
    provider: runtime?.[role]?.provider?.trim() || "unknown",
    model: runtime?.[role]?.model?.trim() || "unknown",
  };
}

function modelUsage(
  usage: RunTokenUsage,
  provider: string,
  model: string,
): ModelTokenUsage {
  let current = usage.models.find(
    (entry) => entry.provider === provider && entry.model === model,
  );
  if (!current) {
    current = { provider, model, ...emptyTokenUsage() };
    usage.models.push(current);
    usage.models.sort((left, right) =>
      `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`)
    );
  }
  return current;
}

function providerUsage(
  usage: RunTokenUsage,
  provider: string,
): ProviderUsage {
  let current = usage.providers.find((entry) => entry.provider === provider);
  if (!current) {
    current = { provider, ...emptyTokenUsage() };
    usage.providers.push(current);
    usage.providers.sort((left, right) =>
      left.provider.localeCompare(right.provider)
    );
  }
  return current;
}

export function initialRunTokenUsage(
  runtime: Partial<Record<ModelRole, Partial<RoleRuntimeConfig>>>,
): RunTokenUsage {
  const agents = Object.fromEntries(
    MODEL_ROLES.map((roleName) => {
      const configured = route(runtime, roleName);
      return [
        roleName,
        createAgentTokenUsage(configured.provider, configured.model),
      ];
    }),
  ) as Record<ModelRole, AgentTokenUsage>;
  const usage: RunTokenUsage = {
    total: emptyTokenUsage(),
    agents,
    providers: [],
    models: [],
  };
  for (const agent of Object.values(agents)) {
    providerUsage(usage, agent.provider);
    modelUsage(usage, agent.provider, agent.model);
  }
  return usage;
}

export function addAgentUsage(
  usage: RunTokenUsage,
  roleName: ModelRole,
  value: AgentTokenUsage,
): void {
  const agent = usage.agents[roleName];
  if (
    agent.provider !== "unknown" &&
    (agent.provider !== value.provider || agent.model !== value.model)
  ) {
    throw new Error(
      `Agent usage route mismatch for ${roleName}: expected ${agent.provider}/${agent.model}, received ${value.provider}/${value.model}`,
    );
  }
  agent.provider = value.provider;
  agent.model = value.model;
  addTokenUsage(agent, value);
  addTokenUsage(usage.total, value);
  addTokenUsage(providerUsage(usage, value.provider), value);
  addTokenUsage(modelUsage(usage, value.provider, value.model), value);
}

export function normalizeRunTokenUsage(
  value: unknown,
  runtime: Partial<Record<ModelRole, Partial<RoleRuntimeConfig>>>,
): RunTokenUsage {
  const raw = record(value);
  const rawAgents = record(raw.agents);
  const usage = initialRunTokenUsage(runtime);
  usage.total = emptyTokenUsage();
  usage.providers = [];
  usage.models = [];
  for (const roleName of MODEL_ROLES) {
    const configured = route(runtime, roleName);
    const source = record(rawAgents[roleName]);
    const agent: AgentTokenUsage = {
      provider:
        typeof source.provider === "string" && source.provider.trim()
          ? source.provider.trim()
          : configured.provider,
      model:
        typeof source.model === "string" && source.model.trim()
          ? source.model.trim()
          : configured.model,
      ...normalizeTokenUsage(source),
    };
    usage.agents[roleName] = agent;
    addTokenUsage(usage.total, agent);
    addTokenUsage(providerUsage(usage, agent.provider), agent);
    addTokenUsage(modelUsage(usage, agent.provider, agent.model), agent);
  }
  return usage;
}

export function formatTokenCount(value: number): string {
  if (value < 1_000) return String(value);
  const units = [
    { value: 1_000_000_000, suffix: "b" },
    { value: 1_000_000, suffix: "m" },
    { value: 1_000, suffix: "k" },
  ];
  const unit = units.find((candidate) => value >= candidate.value)!;
  return `${(value / unit.value).toFixed(1).replace(/\.0$/, "")}${unit.suffix}`;
}

export function formatTokenUsageCompact(usage: TokenUsage): string {
  const reporting = usage.reportedRequests === usage.requests
    ? `${usage.requests} call${usage.requests === 1 ? "" : "s"}`
    : `${usage.reportedRequests}/${usage.requests} calls reported`;
  return `${formatTokenCount(usage.totalTokens)} tok (in ${formatTokenCount(usage.inputTokens)}, out ${formatTokenCount(usage.outputTokens)}, cache ${formatTokenCount(usage.cachedInputTokens)}, reason ${formatTokenCount(usage.reasoningTokens)}; ${reporting})`;
}

export function formatRunTokenUsage(usage: RunTokenUsage): string {
  const agents = MODEL_ROLES.map((roleName) => {
    const current = usage.agents[roleName];
    return `  ${roleName.padEnd(18)} ${current.provider}/${current.model}  ${formatTokenUsageCompact(current)}`;
  });
  const providers = usage.providers.map((current) =>
    `  ${current.provider.padEnd(18)} ${formatTokenUsageCompact(current)}`
  );
  const models = usage.models.map((current) =>
    `  ${(current.provider + "/" + current.model).padEnd(28)} ${formatTokenUsageCompact(current)}`
  );
  return [
    `Total: ${formatTokenUsageCompact(usage.total)}`,
    "Agents:",
    ...agents,
    "Providers:",
    ...providers,
    "Models:",
    ...models,
  ].join("\n");
}
