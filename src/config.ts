import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  parse as parseJsonc,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser";
import { parse as parseYaml } from "yaml";
import {
  MODEL_ROLES,
  type ModelCatalogProtocol,
  type ModelRole,
  type ProviderProtocol,
  type ProviderRuntimeConfig,
  type ResolvedVexConfig,
  type RoleRuntimeConfig,
  type ThinkingLevel,
} from "./types.js";
import { DEFAULT_MAX_REPAIR_ATTEMPTS } from "./defaults.js";

const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export interface AgentConfigInput {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface ProviderConfigInput {
  protocol?: ProviderProtocol;
  modelCatalog?: ModelCatalogProtocol;
  baseUrl?: string;
  apiKeyEnv?: string;
  requiresAuth?: boolean;
  headersEnv?: Record<string, string>;
  sendReasoningEffort?: boolean;
  timeoutMs?: number;
  maxAgentTurns?: number;
}

export interface VexConfigInput {
  defaultProvider?: string;
  defaultModel?: string;
  maxParallelWriters?: number;
  maxRepairAttempts?: number;
  projectCommands?: string[];
  provider?: ProviderConfigInput;
  providers?: Record<string, ProviderConfigInput>;
  agents?: Partial<Record<ModelRole, AgentConfigInput>>;
}

export interface VexConfigLoaderOptions {
  inline?: VexConfigInput;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
}

interface LoadedConfig {
  config: VexConfigInput;
  sources: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeBaseUrl(value: unknown, location: string): string {
  if (typeof value !== "string") throw new Error(`${location} must be a URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${location} must be a URL`);
  }
  if (!/^https?:$/.test(url.protocol)) {
    throw new Error(`${location} must use http or https`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${location} must not contain credentials, query, or fragment`);
  }
  return value.replace(/\/$/, "");
}

function normalizeThinking(value: unknown, location: string): ThinkingLevel {
  const normalized = value === "none" ? "off" : value;
  if (
    typeof normalized !== "string" ||
    !THINKING_LEVELS.includes(normalized as ThinkingLevel)
  ) {
    throw new Error(
      `${location} must be one of: ${THINKING_LEVELS.join(", ")}`,
    );
  }
  return normalized as ThinkingLevel;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown) throw new Error(`${location} contains unknown key: ${unknown}`);
}

function validateConfig(value: unknown, location: string): VexConfigInput {
  if (!isRecord(value)) throw new Error(`${location} must contain an object`);
  assertKnownKeys(
    value,
    [
      "$schema",
      "defaultProvider",
      "defaultModel",
      "maxParallelWriters",
      "maxRepairAttempts",
      "projectCommands",
      "provider",
      "providers",
      "agents",
    ],
    location,
  );
  const result: VexConfigInput = {};
  if (value.defaultProvider !== undefined) {
    if (
      typeof value.defaultProvider !== "string" ||
      !/^[a-z0-9][a-z0-9._-]*$/i.test(value.defaultProvider)
    ) {
      throw new Error(`${location}.defaultProvider must be a provider ID`);
    }
    result.defaultProvider = value.defaultProvider.toLowerCase();
  }
  if (value.defaultModel !== undefined) {
    if (typeof value.defaultModel !== "string" || !value.defaultModel.trim()) {
      throw new Error(`${location}.defaultModel must be a model string`);
    }
    result.defaultModel = value.defaultModel.trim();
  }
  if (value.maxParallelWriters !== undefined) {
    const count = Number(value.maxParallelWriters);
    if (!Number.isInteger(count) || count < 1 || count > 2) {
      throw new Error(`${location}.maxParallelWriters must be 1 or 2`);
    }
    result.maxParallelWriters = count;
  }
  if (value.maxRepairAttempts !== undefined) {
    const count = Number(value.maxRepairAttempts);
    if (!Number.isInteger(count) || count < 0 || count > 5) {
      throw new Error(`${location}.maxRepairAttempts must be between 0 and 5`);
    }
    result.maxRepairAttempts = count;
  }
  if (value.projectCommands !== undefined) {
    if (
      !Array.isArray(value.projectCommands) ||
      value.projectCommands.some(
        (command) => typeof command !== "string" || !command.trim(),
      )
    ) {
      throw new Error(`${location}.projectCommands must contain command strings`);
    }
    result.projectCommands = value.projectCommands.map((command) =>
      String(command).trim(),
    );
  }
  if (value.provider !== undefined) {
    if (!isRecord(value.provider)) {
      throw new Error(`${location}.provider must be an object`);
    }
    assertKnownKeys(
      value.provider,
      [
        "protocol",
        "modelCatalog",
        "baseUrl",
        "apiKeyEnv",
        "requiresAuth",
        "headersEnv",
        "sendReasoningEffort",
        "timeoutMs",
        "maxAgentTurns",
      ],
      `${location}.provider`,
    );
    const provider: ProviderConfigInput = {};
    if (value.provider.protocol !== undefined) {
      if (
        value.provider.protocol !== "openai-chat-completions" &&
        value.provider.protocol !== "anthropic-messages"
      ) {
        throw new Error(
          `${location}.provider.protocol must be openai-chat-completions or anthropic-messages`,
        );
      }
      provider.protocol = value.provider.protocol;
    }
    if (value.provider.modelCatalog !== undefined) {
      if (
        value.provider.modelCatalog !== "openai" &&
        value.provider.modelCatalog !== "anthropic"
      ) {
        throw new Error(
          `${location}.provider.modelCatalog must be openai or anthropic`,
        );
      }
      provider.modelCatalog = value.provider.modelCatalog;
    }
    if (value.provider.baseUrl !== undefined) {
      provider.baseUrl = normalizeBaseUrl(
        value.provider.baseUrl,
        `${location}.provider.baseUrl`,
      );
    }
    if (value.provider.apiKeyEnv !== undefined) {
      if (
        typeof value.provider.apiKeyEnv !== "string" ||
        !/^[A-Z_][A-Z0-9_]*$/i.test(value.provider.apiKeyEnv)
      ) {
        throw new Error(`${location}.provider.apiKeyEnv must be an environment name`);
      }
      provider.apiKeyEnv = value.provider.apiKeyEnv;
    }
    if (value.provider.requiresAuth !== undefined) {
      if (typeof value.provider.requiresAuth !== "boolean") {
        throw new Error(`${location}.provider.requiresAuth must be boolean`);
      }
      provider.requiresAuth = value.provider.requiresAuth;
    }
    if (value.provider.headersEnv !== undefined) {
      if (!isRecord(value.provider.headersEnv)) {
        throw new Error(`${location}.provider.headersEnv must be an object`);
      }
      provider.headersEnv = {};
      for (const [header, environmentName] of Object.entries(
        value.provider.headersEnv,
      )) {
        if (!/^[A-Za-z0-9-]+$/.test(header)) {
          throw new Error(
            `${location}.provider.headersEnv contains an invalid header name`,
          );
        }
        if (
          typeof environmentName !== "string" ||
          !/^[A-Z_][A-Z0-9_]*$/i.test(environmentName)
        ) {
          throw new Error(
            `${location}.provider.headersEnv.${header} must name an environment variable`,
          );
        }
        provider.headersEnv[header] = environmentName;
      }
    }
    if (value.provider.sendReasoningEffort !== undefined) {
      if (typeof value.provider.sendReasoningEffort !== "boolean") {
        throw new Error(
          `${location}.provider.sendReasoningEffort must be boolean`,
        );
      }
      provider.sendReasoningEffort = value.provider.sendReasoningEffort;
    }
    if (value.provider.timeoutMs !== undefined) {
      const timeout = Number(value.provider.timeoutMs);
      if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 600_000) {
        throw new Error(
          `${location}.provider.timeoutMs must be between 1000 and 600000`,
        );
      }
      provider.timeoutMs = timeout;
    }
    if (value.provider.maxAgentTurns !== undefined) {
      const turns = Number(value.provider.maxAgentTurns);
      if (!Number.isInteger(turns) || turns < 1 || turns > 200) {
        throw new Error(
          `${location}.provider.maxAgentTurns must be between 1 and 200`,
        );
      }
      provider.maxAgentTurns = turns;
    }
    result.provider = provider;
  }
  if (value.providers !== undefined) {
    if (!isRecord(value.providers)) {
      throw new Error(`${location}.providers must be an object`);
    }
    result.providers = {};
    for (const [rawId, rawProvider] of Object.entries(value.providers)) {
      const id = rawId.toLowerCase();
      if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
        throw new Error(`${location}.providers contains invalid ID: ${rawId}`);
      }
      if (!isRecord(rawProvider)) {
        throw new Error(`${location}.providers.${rawId} must be an object`);
      }
      result.providers[id] = validateConfig(
        { provider: rawProvider },
        `${location}.providers.${rawId}`,
      ).provider!;
    }
  }
  if (value.agents !== undefined) {
    if (!isRecord(value.agents)) {
      throw new Error(`${location}.agents must be an object`);
    }
    result.agents = {};
    for (const [name, rawAgent] of Object.entries(value.agents)) {
      if (!MODEL_ROLES.includes(name as ModelRole)) {
        throw new Error(`${location}.agents contains unknown role: ${name}`);
      }
      if (!isRecord(rawAgent)) {
        throw new Error(`${location}.agents.${name} must be an object`);
      }
      assertKnownKeys(
        rawAgent,
        ["provider", "model", "thinking"],
        `${location}.agents.${name}`,
      );
      const agent: AgentConfigInput = {};
      if (rawAgent.provider !== undefined) {
        if (
          typeof rawAgent.provider !== "string" ||
          !/^[a-z0-9][a-z0-9._-]*$/i.test(rawAgent.provider)
        ) {
          throw new Error(
            `${location}.agents.${name}.provider must be a provider ID`,
          );
        }
        agent.provider = rawAgent.provider.toLowerCase();
      }
      if (rawAgent.model !== undefined) {
        if (typeof rawAgent.model !== "string" || !rawAgent.model.trim()) {
          throw new Error(`${location}.agents.${name}.model must be a model string`);
        }
        agent.model = rawAgent.model.trim();
      }
      if (rawAgent.thinking !== undefined) {
        agent.thinking = normalizeThinking(
          rawAgent.thinking,
          `${location}.agents.${name}.thinking`,
        );
      }
      result.agents[name as ModelRole] = agent;
    }
  }
  return result;
}

function mergeConfig(
  base: VexConfigInput,
  overlay: VexConfigInput,
): VexConfigInput {
  const agents = { ...(base.agents ?? {}) };
  const providers = { ...(base.providers ?? {}) };
  for (const [id, provider] of Object.entries(overlay.providers ?? {})) {
    providers[id] = { ...(providers[id] ?? {}), ...provider };
  }
  for (const role of MODEL_ROLES) {
    if (overlay.agents?.[role]) {
      agents[role] = { ...(agents[role] ?? {}), ...overlay.agents[role] };
    }
  }
  return {
    ...base,
    ...overlay,
    provider: { ...(base.provider ?? {}), ...(overlay.provider ?? {}) },
    providers,
    agents,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function parseConfigText(content: string, filePath: string): unknown {
  if (/\.ya?ml$/i.test(filePath)) return parseYaml(content);
  const errors: ParseError[] = [];
  const value = parseJsonc(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw new Error(
      `${filePath}: ${printParseErrorCode(first.error)} at offset ${first.offset}`,
    );
  }
  return value;
}

async function loadFile(filePath: string): Promise<VexConfigInput> {
  return validateConfig(
    parseConfigText(await readFile(filePath, "utf8"), filePath),
    filePath,
  );
}

async function firstConfig(directory: string): Promise<string | undefined> {
  for (const name of ["config.jsonc", "config.json", "config.yaml", "config.yml"]) {
    const candidate = path.join(directory, name);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function loadLayers(
  root: string,
  options: VexConfigLoaderOptions,
  projectTrusted: boolean,
): Promise<LoadedConfig> {
  const environment = options.environment ?? process.env;
  const home = options.homeDirectory ?? os.homedir();
  const candidates: string[] = [];
  const user = await firstConfig(path.join(home, ".vex"));
  if (user) candidates.push(user);
  if (projectTrusted) {
    const project = await firstConfig(path.join(root, ".vex"));
    if (project) candidates.push(project);
  }
  if (environment.VEX_CONFIG) {
    const explicit = path.resolve(environment.VEX_CONFIG);
    if (!(await exists(explicit))) throw new Error(`VEX_CONFIG not found: ${explicit}`);
    candidates.push(explicit);
  }
  let config: VexConfigInput = {};
  for (const filePath of candidates) {
    config = mergeConfig(config, await loadFile(filePath));
  }
  if (options.inline) {
    config = mergeConfig(config, validateConfig(options.inline, "inline config"));
  }
  return {
    config,
    sources: [...candidates, ...(options.inline ? ["inline"] : [])],
  };
}

export const BUILTIN_PROVIDER_PROFILES: Record<
  string,
  ProviderRuntimeConfig
> = {
  openai: {
    id: "openai",
    protocol: "openai-chat-completions",
    modelCatalog: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "VEX_API_KEY",
    requiresAuth: true,
    headersEnv: {},
    sendReasoningEffort: false,
    timeoutMs: 120_000,
    maxAgentTurns: 60,
  },
  openrouter: {
    id: "openrouter",
    protocol: "openai-chat-completions",
    modelCatalog: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    requiresAuth: true,
    headersEnv: {},
    sendReasoningEffort: false,
    timeoutMs: 120_000,
    maxAgentTurns: 60,
  },
  anthropic: {
    id: "anthropic",
    protocol: "anthropic-messages",
    modelCatalog: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    requiresAuth: true,
    headersEnv: {},
    sendReasoningEffort: false,
    timeoutMs: 120_000,
    maxAgentTurns: 60,
  },
  deepseek: {
    id: "deepseek",
    protocol: "openai-chat-completions",
    modelCatalog: "openai",
    baseUrl: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    requiresAuth: true,
    headersEnv: {},
    sendReasoningEffort: false,
    timeoutMs: 120_000,
    maxAgentTurns: 60,
  },
  ollama: {
    id: "ollama",
    protocol: "openai-chat-completions",
    modelCatalog: "openai",
    baseUrl: "http://localhost:11434/v1",
    requiresAuth: false,
    headersEnv: {},
    sendReasoningEffort: false,
    timeoutMs: 120_000,
    maxAgentTurns: 60,
  },
};

const DEFAULT_THINKING: Record<ModelRole, ThinkingLevel> = {
  scout: "low",
  architect: "high",
  backend: "high",
  frontend: "high",
  "test-engineer": "medium",
  reviewer: "high",
  "security-reviewer": "high",
};

export interface VexRoutingOverrides {
  provider?: string;
  roleRoutes?: Partial<
    Record<ModelRole, { provider?: string; model?: string }>
  >;
}

export interface ResolvedProviderProfiles {
  defaultProvider: string;
  providers: Record<string, ProviderRuntimeConfig>;
}

function resolveProviderProfiles(
  config: VexConfigInput,
  environment: NodeJS.ProcessEnv,
  providerOverride?: string,
): ResolvedProviderProfiles {
  const defaultProvider = (
    providerOverride ??
    environment.VEX_PROVIDER ??
    config.defaultProvider ??
    "openai"
  ).toLowerCase();
  const configured: Record<string, ProviderConfigInput> = {
    ...(config.providers ?? {}),
  };
  configured[defaultProvider] = {
    ...(configured[defaultProvider] ?? {}),
    ...(config.provider ?? {}),
  };
  const ids = new Set([
    ...Object.keys(BUILTIN_PROVIDER_PROFILES),
    ...Object.keys(configured),
  ]);
  const providers: Record<string, ProviderRuntimeConfig> = {};
  for (const id of ids) {
    const builtin = BUILTIN_PROVIDER_PROFILES[id];
    const raw = configured[id] ?? {};
    const baseUrl = raw.baseUrl ?? builtin?.baseUrl;
    if (!baseUrl) {
      throw new Error(`Provider ${id} requires a baseUrl`);
    }
    const apiKeyEnv = raw.apiKeyEnv ?? builtin?.apiKeyEnv;
    const protocol = raw.protocol ?? builtin?.protocol ??
      "openai-chat-completions";
    providers[id] = {
      id,
      protocol,
      modelCatalog: raw.modelCatalog ?? builtin?.modelCatalog ??
        (protocol === "anthropic-messages" ? "anthropic" : "openai"),
      baseUrl: normalizeBaseUrl(baseUrl, `providers.${id}.baseUrl`),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      requiresAuth:
        raw.requiresAuth ?? builtin?.requiresAuth ?? Boolean(apiKeyEnv),
      headersEnv: raw.headersEnv ?? builtin?.headersEnv ?? {},
      sendReasoningEffort:
        raw.sendReasoningEffort ?? builtin?.sendReasoningEffort ?? false,
      timeoutMs: raw.timeoutMs ?? builtin?.timeoutMs ?? 120_000,
      maxAgentTurns: raw.maxAgentTurns ?? builtin?.maxAgentTurns ?? 60,
    };
  }
  const selected = providers[defaultProvider];
  if (!selected) throw new Error(`Unknown default provider: ${defaultProvider}`);
  providers[defaultProvider] = {
    ...selected,
    baseUrl: normalizeBaseUrl(
      environment.VEX_BASE_URL ?? selected.baseUrl,
      `providers.${defaultProvider}.baseUrl`,
    ),
    ...(environment.VEX_API_KEY_ENV
      ? { apiKeyEnv: environment.VEX_API_KEY_ENV }
      : {}),
  };
  return { defaultProvider, providers };
}

export class VexConfigLoader {
  readonly #options: VexConfigLoaderOptions;

  constructor(options: VexConfigLoaderOptions = {}) {
    this.#options = options;
  }

  async resolve(
    root: string,
    modelOverride?: string,
    projectTrusted = true,
    overrides: VexRoutingOverrides = {},
  ): Promise<ResolvedVexConfig> {
    const loaded = await loadLayers(root, this.#options, projectTrusted);
    const environment = this.#options.environment ?? process.env;
    const config = mergeConfig(
      {
        maxParallelWriters: 2,
        maxRepairAttempts: DEFAULT_MAX_REPAIR_ATTEMPTS,
      },
      loaded.config,
    );
    if (environment.VEX_MAX_PARALLEL_WRITERS) {
      config.maxParallelWriters = Number(environment.VEX_MAX_PARALLEL_WRITERS);
      validateConfig(
        { maxParallelWriters: config.maxParallelWriters },
        "environment",
      );
    }
    const profiles = resolveProviderProfiles(
      config,
      environment,
      overrides.provider,
    );
    const environmentModel = modelOverride ?? environment.VEX_MODEL;
    const defaultModel = environmentModel ?? config.defaultModel;
    const agents = Object.fromEntries(
      MODEL_ROLES.map((role) => {
        const agent = config.agents?.[role];
        const route = overrides.roleRoutes?.[role];
        const provider = (
          route?.provider ??
          agent?.provider ??
          profiles.defaultProvider
        ).toLowerCase();
        if (!profiles.providers[provider]) {
          throw new Error(`Unknown provider ${provider} configured for ${role}`);
        }
        const model = route?.model ?? environmentModel ?? agent?.model ?? defaultModel;
        if (!model) {
          throw new Error(
            `No model configured for ${role}. Use /model <model>, set defaultModel in ~/.vex/config.jsonc, or set VEX_MODEL.`,
          );
        }
        const runtime: RoleRuntimeConfig = {
          provider,
          model,
          thinking: agent?.thinking ?? DEFAULT_THINKING[role],
          source: route?.model || route?.provider || modelOverride || overrides.provider
            ? "session"
            : environment.VEX_MODEL || environment.VEX_PROVIDER
              ? "environment"
            : agent?.model || agent?.provider
              ? "agent"
              : "default",
        };
        return [role, runtime];
      }),
    ) as Record<ModelRole, RoleRuntimeConfig>;
    const sources = ["builtin:vex", ...loaded.sources];
    if (environment.VEX_MODEL) sources.push("env:VEX_MODEL");
    if (environment.VEX_BASE_URL) sources.push("env:VEX_BASE_URL");
    if (environment.VEX_PROVIDER) sources.push("env:VEX_PROVIDER");
    if (modelOverride) sources.push("command:model");
    if (overrides.provider || overrides.roleRoutes) sources.push("session:routing");
    return {
      maxParallelWriters: (config.maxParallelWriters ?? 2) as 1 | 2,
      maxRepairAttempts:
        config.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
      projectCommands: config.projectCommands ?? [],
      defaultProvider: profiles.defaultProvider,
      provider: profiles.providers[profiles.defaultProvider]!,
      providers: profiles.providers,
      agents,
      sources,
    };
  }

  async listProviders(
    root: string,
    projectTrusted = false,
  ): Promise<ResolvedProviderProfiles> {
    const loaded = await loadLayers(root, this.#options, projectTrusted);
    return resolveProviderProfiles(
      loaded.config,
      this.#options.environment ?? process.env,
    );
  }
}

export function formatResolvedConfig(config: ResolvedVexConfig): string {
  const roles = MODEL_ROLES.map((role) => {
    const runtime = config.agents[role];
    return `${role}: ${runtime.provider}/${runtime.model} (${runtime.thinking}, ${runtime.source})`;
  }).join("\n");
  const commands = config.projectCommands.length
    ? config.projectCommands.join(" && ")
    : "none";
  const providers = Object.values(config.providers)
    .map((provider) =>
      `${provider.id}: ${provider.protocol} · catalog ${provider.modelCatalog} · ${provider.baseUrl}${provider.apiKeyEnv ? ` (env ${provider.apiKeyEnv})` : ""}`,
    )
    .join("\n");
  return `Default provider: ${config.defaultProvider}\nProviders:\n${providers}\nConcurrency: ${config.maxParallelWriters}; repair attempts: ${config.maxRepairAttempts}\nRole routing:\n${roles}\nProject commands: ${commands}\nSources: ${config.sources.join(" -> ")}`;
}
