#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ask,
  chatPrompt,
  clearAndRender,
  confirm,
  readSecret,
  renderDashboard,
  renderHome,
  selectItem,
  selectProviderModel,
  selectProviderModelAndTarget,
  type LineHint,
  type LineCompleter,
  type LineHintProvider,
  type ProviderModelPane,
  type SelectItem,
} from "./cli-ui.js";
import {
  VexAuthStore,
  type AuthInfo,
} from "./auth.js";
import { describeProxyForUrl } from "./http-client.js";
import {
  loginWithOpenAiBrowser,
  OPENAI_OAUTH_ISSUER,
} from "./openai-oauth.js";
import {
  DEFAULT_MAX_REPAIR_ATTEMPTS,
} from "./defaults.js";
import {
  formatResolvedConfig,
  normalizeBaseUrl,
  VexConfigLoader,
  type ProviderConfigInput,
} from "./config.js";
import {
  NoopKnowledgeProvider,
  RoleKnowledgeClient,
} from "./knowledge.js";
import {
  formatTechnicalReview,
  VEX_WORK_MODES,
  VexModeService,
  type VexWorkMode,
} from "./modes.js";
import { VexOrchestrator } from "./orchestrator.js";
import { FileOwnershipPolicy } from "./policy.js";
import { loadRoles } from "./roles.js";
import { NativeAgentRunner } from "./runner.js";
import {
  discoverProviderModels,
  type ProviderModel,
  type ProviderModelCatalog,
} from "./provider-transport.js";
import {
  formatExecutionPlan,
  formatRunState,
  formatUsageState,
  type ActiveVexRun,
  VexService,
} from "./service.js";
import { RunStateStore } from "./state-store.js";
import {
  MODEL_ROLES,
  type ModelRole,
  type ProviderRuntimeConfig,
  type VexRunOptions,
  type VexRunState,
} from "./types.js";
import { WorktreeManager } from "./worktrees.js";
import { VEX_VERSION } from "./version.js";

const VERSION = VEX_VERSION;

export type CliCommand =
  | "interactive"
  | "auto"
  | "chat"
  | "assess"
  | "code-review"
  | "run"
  | "plan"
  | "status"
  | "usage"
  | "diff"
  | "resume"
  | "review"
  | "merge"
  | "abort"
  | "cleanup"
  | "config"
  | "provider"
  | "providers"
  | "models"
  | "logout"
  | "init"
  | "help"
  | "version";

export interface CliInvocation {
  command: CliCommand;
  values: string[];
  options: VexRunOptions & {
    yes: boolean;
    json: boolean;
    global: boolean;
  };
}

const COMMANDS = new Set<CliCommand>([
  "auto",
  "chat",
  "assess",
  "code-review",
  "run",
  "plan",
  "status",
  "usage",
  "diff",
  "resume",
  "review",
  "merge",
  "abort",
  "cleanup",
  "config",
  "provider",
  "providers",
  "models",
  "logout",
  "init",
  "help",
  "version",
]);

export function parseCliArguments(argv: string[]): CliInvocation {
  if (argv.length === 0) {
    return {
      command: "interactive",
      values: [],
      options: { yes: false, json: false, global: false },
    };
  }
  if (argv[0] === "--help" || argv[0] === "-h") argv = ["help", ...argv.slice(1)];
  if (argv[0] === "--version" || argv[0] === "-v") argv = ["version", ...argv.slice(1)];
  if (argv[0] === "code") argv = ["run", ...argv.slice(1)];
  if (argv[0] === "connect" || argv[0] === "login") {
    argv = ["provider", ...argv.slice(1)];
  }
  if (argv[0] === "ask") argv = ["chat", ...argv.slice(1)];
  if (argv[0] === "inspect") argv = ["assess", ...argv.slice(1)];
  const first = argv[0] as CliCommand;
  const command = COMMANDS.has(first) ? first : "auto";
  const tokens = COMMANDS.has(first) ? argv.slice(1) : argv;
  const values: string[] = [];
  const options: CliInvocation["options"] = {
    yes: false,
    json: false,
    global: false,
  };
  let parsingOptions = true;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (parsingOptions && token === "--") {
      parsingOptions = false;
      continue;
    }
    if (parsingOptions && token === "--security") {
      options.securityReview = true;
      continue;
    }
    if (parsingOptions && token === "--trust-project") {
      options.projectTrusted = true;
      continue;
    }
    if (parsingOptions && token === "--yes") {
      options.yes = true;
      continue;
    }
    if (parsingOptions && token === "--json") {
      options.json = true;
      continue;
    }
    if (parsingOptions && token === "--global") {
      options.global = true;
      continue;
    }
    if (parsingOptions && (token === "--model" || token.startsWith("--model="))) {
      const value = token === "--model" ? tokens[++index] : token.slice(8);
      if (!value) throw new Error("--model requires a model ID");
      options.model = value;
      continue;
    }
    if (
      parsingOptions &&
      (token === "--provider" || token.startsWith("--provider="))
    ) {
      const value = token === "--provider" ? tokens[++index] : token.slice(11);
      if (!value) throw new Error("--provider requires a provider ID");
      options.provider = value.toLowerCase();
      continue;
    }
    if (parsingOptions && token.startsWith("--")) {
      throw new Error(`Unknown option: ${token}`);
    }
    parsingOptions = false;
    values.push(token);
  }
  return { command, values, options };
}

export type InteractiveInput =
  | { kind: "empty" }
  | { kind: "prompt"; text: string }
  | { kind: "quit" }
  | { kind: "clear" }
  | { kind: "help" }
  | { kind: "routing" }
  | { kind: "set-mode"; mode: string }
  | { kind: "set-provider"; provider: string; method: string }
  | { kind: "set-model"; model: string }
  | { kind: "set-route"; role: string; provider: string; model: string }
  | { kind: "unknown"; command: string }
  | { kind: "invoke"; invocation: CliInvocation };

function interactiveInvocation(
  command: CliCommand,
  values: string[] = [],
  options: Partial<CliInvocation["options"]> = {},
): InteractiveInput {
  return {
    kind: "invoke",
    invocation: {
      command,
      values,
      options: {
        yes: false,
        json: false,
        global: false,
        ...options,
      },
    },
  };
}

export function parseInteractiveInput(input: string): InteractiveInput {
  const trimmed = input.trim();
  if (!trimmed) return { kind: "empty" };
  if (!trimmed.startsWith("/")) {
    return { kind: "prompt", text: trimmed };
  }

  const separator = trimmed.search(/\s/);
  const command = (separator === -1 ? trimmed : trimmed.slice(0, separator))
    .toLowerCase();
  const argument = separator === -1 ? "" : trimmed.slice(separator).trim();
  if (command === "/quit" || command === "/exit" || command === "/q") {
    return { kind: "quit" };
  }
  if (command === "/clear") return { kind: "clear" };
  if (command === "/help" || command === "/?") return { kind: "help" };
  if (command === "/routing") return { kind: "routing" };
  if (command === "/mode") {
    return { kind: "set-mode", mode: argument.toLowerCase() };
  }
  if (command === "/provider") {
    const [provider = "", method = ""] = argument
      .split(/\s+/)
      .filter(Boolean);
    return {
      kind: "set-provider",
      provider: provider.toLowerCase(),
      method: method.toLowerCase(),
    };
  }
  if (command === "/model") {
    return { kind: "set-model", model: argument };
  }
  if (command === "/route") {
    const [role = "", provider = "", ...modelParts] = argument.split(/\s+/);
    return {
      kind: "set-route",
      role: role.toLowerCase(),
      provider: provider.toLowerCase(),
      model: modelParts.join(" "),
    };
  }
  if (command === "/run") {
    return interactiveInvocation("run", argument ? [argument] : []);
  }
  if (command === "/auto") {
    return interactiveInvocation("auto", argument ? [argument] : []);
  }
  if (command === "/chat") {
    return interactiveInvocation("chat", argument ? [argument] : []);
  }
  if (command === "/assess" || command === "/inspect") {
    return interactiveInvocation("assess", argument ? [argument] : []);
  }
  if (command === "/code-review") {
    return interactiveInvocation("code-review", argument ? [argument] : []);
  }
  if (command === "/plan") {
    return interactiveInvocation("plan", argument ? [argument] : []);
  }
  if (command === "/security") {
    return interactiveInvocation("run", argument ? [argument] : [], {
      securityReview: true,
    });
  }
  if (
    command === "/status" ||
    command === "/usage" ||
    command === "/diff" ||
    command === "/resume" ||
    command === "/review" ||
    command === "/merge" ||
    command === "/abort" ||
    command === "/cleanup"
  ) {
    return interactiveInvocation(
      command.slice(1) as CliCommand,
      argument ? [argument] : [],
    );
  }
  if (command === "/config") return interactiveInvocation("config");
  if (command === "/providers") return interactiveInvocation("providers");
  if (command === "/logout") {
    return interactiveInvocation(
      "logout",
      argument
        ? argument.split(/\s+/).map((value) => value.toLowerCase())
        : [],
    );
  }
  if (command === "/init") {
    return interactiveInvocation("init", [], { global: argument === "--global" });
  }
  return { kind: "unknown", command };
}

export function interactiveHelp(): string {
  return `Enter natural language directly. VEX routes it to chat, review, code review, or implementation.
Type / for live command hints. Use Up/Down to choose and Tab to complete commands or their Provider, mode, role, and model arguments. At a normal prompt, Up recalls history.

  /mode [mode]       select auto, chat, review, code-review, or implement
  /auto <prompt>     classify this prompt and choose a mode
  /chat <message>    pure conversation; no workspace tools
  /assess <scope>    read-only technical review of this workspace
  /code-review <scope>
                     reviewer-only read-only code review; no Scout
  /plan <task>       create a plan without starting writers
  /run <task>        explicitly use the implementation workflow
  /security <task>   run with Security Reviewer enabled
  /status [run-id]   show the latest or selected run
  /usage [run-id]    show Token use by Agent, Provider, and model
  /diff [run-id]     inspect the integration diff
  /resume [run-id]   continue a persisted run
  /review [run-id]   rerun reviewers
  /merge [run-id]    explicitly merge an approved run
  /abort [run-id]    abort an active or persisted run
  /cleanup [run-id]  remove retained worktrees
  /config            show provider and role routing
  /providers         list Provider profiles and login status
  /provider [id] [oauth|api-key|setup]
                     connect a Provider; add/configure NewAPI or Sub2API
  /logout [provider] select and remove a saved login
  /model [provider|query]
                     choose models and assign targets; Esc finishes
  /route [role] [provider] [model]
                     repeatedly choose model then role, or set one explicitly
  /routing           show saved user model routing and session mode
  /init [--global]   create VEX configuration
  /clear             redraw the coding session
  /quit              exit VEX`;
}

const INTERACTIVE_COMMAND_COMPLETIONS = [
  "/help",
  "/mode ",
  "/auto ",
  "/chat ",
  "/assess ",
  "/code-review ",
  "/plan ",
  "/run ",
  "/security ",
  "/status ",
  "/usage ",
  "/diff ",
  "/resume ",
  "/review ",
  "/merge ",
  "/abort ",
  "/cleanup ",
  "/config",
  "/providers",
  "/logout ",
  "/provider ",
  "/model ",
  "/route ",
  "/routing",
  "/init ",
  "/clear",
  "/quit",
] as const;

const INTERACTIVE_COMMAND_DESCRIPTIONS: Record<string, string> = {
  "/provider": "choose a Provider and authenticate when required",
  "/model": "assign Provider/models to targets; Esc when done",
  "/mode": "select auto, chat, review, code-review, or implement",
  "/route": "assign Provider/models to Agent roles; Esc when done",
  "/chat": "one pure conversation turn without workspace tools",
  "/assess": "one read-only technical review",
  "/code-review": "review repository code with only the Reviewer role",
  "/auto": "classify one prompt and choose its work mode",
  "/run": "start the implementation workflow",
  "/plan": "create a plan without starting writers",
  "/security": "run implementation with Security Reviewer enabled",
  "/providers": "list Provider profiles and authentication status",
  "/routing": "show saved user model routing and session mode",
  "/logout": "remove a saved Provider login",
  "/config": "show resolved Provider and role configuration",
  "/status": "show the latest or selected run",
  "/usage": "show Token use by Agent, Provider, and model",
  "/diff": "inspect an integration diff",
  "/resume": "continue a persisted run",
  "/review": "rerun technical reviewers",
  "/merge": "merge an approved run",
  "/abort": "abort an active or persisted run",
  "/cleanup": "remove retained worktrees",
  "/init": "create VEX configuration",
  "/clear": "redraw the VEX workspace",
  "/help": "show every interactive command",
  "/quit": "exit VEX",
};

const INTERACTIVE_HINT_PRIORITY = [
  "/provider",
  "/model",
  "/mode",
  "/route",
  "/chat",
  "/code-review",
  "/assess",
  "/run",
  "/help",
  "/providers",
  "/routing",
  "/plan",
  "/security",
  "/status",
  "/usage",
  "/diff",
  "/resume",
  "/review",
  "/merge",
  "/abort",
  "/cleanup",
  "/logout",
  "/config",
  "/init",
  "/clear",
  "/auto",
  "/quit",
] as const;

export interface InteractiveCompletionContext {
  providers: string[];
  models: Array<{ provider: string; model: string }>;
}

export function modelSelectionFilter(
  value: string,
  providers: readonly string[],
): { requestedProvider?: string; initialQuery?: string } {
  const query = value.trim();
  if (!query) return {};
  const normalized = query.toLowerCase();
  return providers.some((provider) => provider.toLowerCase() === normalized)
    ? { requestedProvider: normalized }
    : { initialQuery: query };
}

function completionMatches(line: string, candidates: readonly string[]): string[] {
  const normalized = line.toLowerCase();
  return [...new Set(candidates)]
    .filter((candidate) => candidate.toLowerCase().startsWith(normalized))
    .sort((left, right) => left.localeCompare(right));
}

export function createInteractiveCompleter(
  context: InteractiveCompletionContext,
): LineCompleter {
  return (line) => {
    const value = line.trimStart();
    if (!value.startsWith("/")) return [[], line];
    const separator = value.search(/\s/);
    if (separator === -1) {
      return [completionMatches(value, INTERACTIVE_COMMAND_COMPLETIONS), value];
    }

    const command = value.slice(0, separator).toLowerCase();
    const argumentText = value.slice(separator).trimStart();
    const parts = argumentText ? argumentText.split(/\s+/) : [];
    const endsWithSpace = /\s$/.test(value);
    let candidates: string[] = [];
    if (command === "/mode") {
      candidates = VEX_WORK_MODES.map((mode) => `/mode ${mode}`);
    } else if (command === "/logout") {
      candidates = context.providers.map((provider) => `${command} ${provider}`);
    } else if (command === "/provider") {
      if (parts.length === 0 || (parts.length === 1 && !endsWithSpace)) {
        candidates = [...new Set([
          ...context.providers,
          ...CUSTOM_PROVIDER_FORMATS,
          "add",
        ])].map(
          (provider) => `${command} ${provider} `,
        );
      } else {
        const provider = parts[0]!;
        candidates = provider === "add"
          ? CUSTOM_PROVIDER_FORMATS.map(
            (format) => `${command} add ${format}`,
          )
          : [
              `${command} ${provider} api-key`,
              ...(provider === "openai"
                ? [`${command} ${provider} oauth`]
                : []),
              ...(CUSTOM_PROVIDER_FORMATS.includes(
                  provider as CustomProviderFormat,
                )
                ? [`${command} ${provider} setup`]
                : []),
            ];
      }
    } else if (command === "/model") {
      candidates = context.models.map(({ model }) => `/model ${model}`);
    } else if (command === "/route") {
      if (parts.length === 0 || (parts.length === 1 && !endsWithSpace)) {
        candidates = MODEL_ROLES.map((role) => `/route ${role} `);
      } else if (parts.length === 1 || (parts.length === 2 && !endsWithSpace)) {
        const role = parts[0]!;
        candidates = context.providers.map(
          (provider) => `/route ${role} ${provider} `,
        );
      } else {
        const role = parts[0]!;
        const provider = parts[1]!;
        candidates = context.models
          .filter((model) => model.provider === provider)
          .map((model) => `/route ${role} ${provider} ${model.model}`);
      }
    } else if (command === "/init") {
      candidates = ["/init --global"];
    }
    return [completionMatches(value, candidates), value];
  };
}

function describeInteractiveHint(
  candidate: string,
  context: InteractiveCompletionContext,
): string | undefined {
  const [command = "", ...arguments_] = candidate.trim().split(/\s+/);
  if (arguments_.length === 0) {
    return INTERACTIVE_COMMAND_DESCRIPTIONS[command];
  }
  if (command === "/mode") {
    const mode = arguments_[0] as VexWorkMode;
    return VEX_WORK_MODES.includes(mode) ? MODE_DESCRIPTIONS[mode] : undefined;
  }
  if (command === "/provider") {
    if (arguments_.length === 1) {
      const provider = arguments_[0]!;
      if (provider === "add") return "add a custom NewAPI or Sub2API endpoint";
      return `${PROVIDER_NAMES[provider] ?? provider} Provider`;
    }
    if (arguments_[0] === "add") {
      return `configure a custom ${PROVIDER_NAMES[arguments_[1]!] ?? arguments_[1]} endpoint and API key`;
    }
    if (arguments_[1] === "setup") {
      return "change the custom endpoint and API key";
    }
    return arguments_[1] === "oauth"
      ? "browser authorization; no API key required"
      : "save an API key in the VEX auth store";
  }
  if (command === "/logout") {
    const provider = arguments_[0]!;
    return `${PROVIDER_NAMES[provider] ?? provider} Provider`;
  }
  if (command === "/model") {
    const model = arguments_.join(" ");
    const provider = context.models.find((entry) => entry.model === model)?.provider;
    return provider ? `${PROVIDER_NAMES[provider] ?? provider} model` : "discovered model";
  }
  if (command === "/route") {
    if (arguments_.length === 1) {
      const role = arguments_[0] as ModelRole;
      return MODEL_ROLES.includes(role) ? ROLE_DESCRIPTIONS[role] : undefined;
    }
    if (arguments_.length === 2) {
      const provider = arguments_[1]!;
      return `${PROVIDER_NAMES[provider] ?? provider} Provider`;
    }
    return `${PROVIDER_NAMES[arguments_[1]!] ?? arguments_[1]} model for ${arguments_[0]}`;
  }
  if (command === "/init" && arguments_[0] === "--global") {
    return "write configuration under ~/.vex";
  }
  return INTERACTIVE_COMMAND_DESCRIPTIONS[command];
}

export function createInteractiveHintProvider(
  context: InteractiveCompletionContext,
): LineHintProvider {
  const completer = createInteractiveCompleter(context);
  const priority = new Map<string, number>(
    INTERACTIVE_HINT_PRIORITY.map((command, index) => [command, index]),
  );
  return (line): LineHint[] => {
    const value = line.trimStart();
    if (!value.startsWith("/")) return [];
    const rootCommand = !/\s/.test(value);
    const candidates = [...completer(value)[0]];
    if (rootCommand) {
      candidates.sort((left, right) => {
        const leftCommand = left.trimEnd();
        const rightCommand = right.trimEnd();
        const normalizedValue = value.toLowerCase();
        const leftExact = leftCommand.toLowerCase() === normalizedValue;
        const rightExact = rightCommand.toLowerCase() === normalizedValue;
        return Number(rightExact) - Number(leftExact) ||
          (priority.get(leftCommand) ?? Number.MAX_SAFE_INTEGER) -
            (priority.get(rightCommand) ?? Number.MAX_SAFE_INTEGER) ||
          left.localeCompare(right);
      });
    }
    return candidates.map((candidate): LineHint => {
      const description = describeInteractiveHint(candidate, context);
      return {
        value: candidate,
        ...(description ? { description } : {}),
      };
    });
  };
}

interface Runtime {
  service: VexService;
  modes: VexModeService;
  worktrees: WorktreeManager;
  config: VexConfigLoader;
  auth: VexAuthStore;
}

async function createRuntime(): Promise<Runtime> {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDirectory, "..");
  const roles = await loadRoles(path.join(packageRoot, "roles"));
  const store = new RunStateStore();
  const worktrees = new WorktreeManager();
  const config = new VexConfigLoader();
  const auth = new VexAuthStore();
  const runner = new NativeAgentRunner({ auth });
  const orchestrator = new VexOrchestrator({
    roles,
    runner,
    knowledge: new RoleKnowledgeClient(new NoopKnowledgeProvider()),
    worktrees,
    policy: new FileOwnershipPolicy(),
    store,
    config,
  });
  return {
    service: new VexService(orchestrator, store, worktrees),
    modes: new VexModeService({
      roles,
      runner,
      config,
      worktrees,
      auth,
    }),
    worktrees,
    config,
    auth,
  };
}

function help(): string {
  return `VEX ${VERSION} — independent adaptive engineering CLI

Usage:
  vex                         open the interactive workspace
  vex <prompt>                semantically select chat, review, code review, or implement
  vex chat <message>          pure conversation without workspace access
  vex assess <scope>          read-only technical review
  vex code-review <scope>     read-only review using only Reviewer
  vex run <task>              plan, confirm, and execute
  vex code <task>             alias for run
  vex plan <task>             create a plan without writers
  vex status [run-id]         show a persisted run
  vex usage [run-id]          show Token use by Agent, Provider, and model
  vex diff [run-id]           show the integration diff
  vex resume [run-id]         resume a plan or interrupted run
  vex review [run-id]         rerun reviewers
  vex merge [run-id]          explicitly fast-forward an approved run
  vex abort [run-id]          stop or mark a run aborted
  vex cleanup [run-id]        remove retained worktrees
  vex config                  show provider and role routing
  vex providers               list Provider profiles and auth status
  vex provider [id] [oauth|api-key|setup]
                              connect a Provider; add/configure gateway formats
  vex provider add [newapi|sub2api]
                              save a custom endpoint and API key
  vex models [provider]       list every connected catalog, or one Provider
  vex logout [provider]       select and remove a saved login
  vex init [--global]         create an independent VEX config

Run options:
  --model <id>                override every role model for this run
  --provider <id>             override the default Provider for this run
  --security                  enable Security Reviewer
  --trust-project             load <repo>/.vex/config.*
  --yes                       accept the execution prompt
  --json                      print machine-readable state

Environment:
  VEX_PROVIDER, VEX_MODEL, VEX_BASE_URL, VEX_API_KEY, VEX_CONFIG
  ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, OPENROUTER_API_KEY
  VEX_PROXY, VEX_NO_PROXY       override or bypass the detected network proxy
`;
}

async function monitor(
  runtime: Runtime,
  cwd: string,
  active: ActiveVexRun,
): Promise<VexRunState> {
  let outcome:
    | { ok: true; state: VexRunState }
    | { ok: false; error: unknown }
    | undefined;
  void active.promise.then(
    (state) => {
      outcome = { ok: true, state };
    },
    (error) => {
      outcome = { ok: false, error };
    },
  );
  let lastUpdate = "";
  const abort = () => runtime.service.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    while (!outcome) {
      try {
        const state = await runtime.service.status(cwd, active.id);
        if (state && state.updatedAt !== lastUpdate) {
          lastUpdate = state.updatedAt;
          if (process.stdout.isTTY) clearAndRender(renderDashboard(state));
          else process.stdout.write(`${formatRunState(state)}\n`);
        }
      } catch {
        // The initial state may not exist during the first preflight tick.
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
  if (!outcome.ok) throw outcome.error;
  if (process.stdout.isTTY) clearAndRender(renderDashboard(outcome.state));
  return outcome.state;
}

async function repositoryView(runtime: Runtime, cwd: string) {
  const workspace = await runtime.worktrees.inspectWorkspace(cwd);
  const latest = await runtime.service.status(workspace.root);
  return { ...workspace, ...(latest ? { latest } : {}) };
}

interface InteractiveRoutingState {
  provider?: string;
  model?: string;
  roleRoutes: Partial<Record<ModelRole, { provider?: string; model?: string }>>;
}

type ProviderAuthState = "keyless" | "environment" | "saved" | "missing";
type ProviderLoginMethod = "oauth" | "api-key";
export type CustomProviderFormat = "newapi" | "sub2api";

interface ProviderEntry {
  provider: ProviderRuntimeConfig;
  isDefault: boolean;
  auth: ProviderAuthState;
  credential?: AuthInfo;
}

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  anthropic: "Claude (Anthropic)",
  deepseek: "DeepSeek",
  ollama: "Ollama",
  newapi: "NewAPI",
  sub2api: "Sub2API",
};

const CUSTOM_PROVIDER_FORMATS = ["newapi", "sub2api"] as const;
const CUSTOM_PROVIDER_SELECTION_PREFIX = "vex:add-provider:";

export function customProviderProfile(
  format: CustomProviderFormat,
  baseUrl: string,
): ProviderConfigInput {
  if (format === "sub2api") {
    return {
      protocol: "anthropic-messages",
      modelCatalog: "openai",
      baseUrl,
      requiresAuth: true,
    };
  }
  return {
    protocol: "openai-chat-completions",
    modelCatalog: "openai",
    baseUrl,
    requiresAuth: true,
  };
}

const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
  scout: "repository discovery and context",
  architect: "planning and technical design",
  backend: "backend implementation",
  frontend: "frontend implementation",
  "test-engineer": "tests and verification",
  reviewer: "quality review and repair gate",
  "security-reviewer": "optional security review",
};

const MODE_DESCRIPTIONS: Record<VexWorkMode, string> = {
  auto: "infer chat, review, code review, or implementation from each prompt",
  chat: "conversation only; no workspace access or changes",
  review: "read-only Scout and Technical Reviewer",
  "code-review": "read-only Reviewer only; no Scout or writers",
  implement: "full multi-agent plan, implementation, review, and merge gate",
};

function providerAuthLabel(entry: ProviderEntry): string {
  if (entry.auth === "keyless") return "no login required";
  if (entry.auth === "environment") {
    return `authenticated via ${entry.provider.apiKeyEnv}`;
  }
  if (entry.auth === "saved") {
    return entry.credential?.type === "oauth"
      ? "ChatGPT OAuth"
      : "API key saved";
  }
  return "login required";
}

async function providerEntries(
  runtime: Runtime,
  cwd: string,
): Promise<ProviderEntry[]> {
  const root = await runtime.worktrees.resolveWorkspaceRoot(cwd);
  const profiles = await runtime.config.listProviders(root, false);
  const savedCredentials = await runtime.auth.savedCredentials();
  return Object.values(profiles.providers)
    .map((provider): ProviderEntry => {
      const environmentAuth = Boolean(
        provider.apiKeyEnv && process.env[provider.apiKeyEnv],
      );
      const savedCredential = savedCredentials[provider.id];
      const auth: ProviderAuthState = !provider.requiresAuth
        ? "keyless"
        : environmentAuth
          ? "environment"
          : savedCredential
            ? "saved"
            : "missing";
      return {
        provider,
        isDefault: provider.id === profiles.defaultProvider,
        auth,
        ...(savedCredential ? { credential: savedCredential } : {}),
      };
    })
    .sort(
      (left, right) =>
        Number(right.isDefault) - Number(left.isDefault) ||
        left.provider.id.localeCompare(right.provider.id),
    );
}

async function requireProviderEntry(
  runtime: Runtime,
  cwd: string,
  providerId: string,
): Promise<ProviderEntry> {
  const entry = (await providerEntries(runtime, cwd)).find(
    (candidate) => candidate.provider.id === providerId.toLowerCase(),
  );
  if (!entry) {
    throw new Error(
      `Unknown Provider: ${providerId}. Use /providers to list profiles.`,
    );
  }
  return entry;
}

async function chooseProvider(
  runtime: Runtime,
  cwd: string,
  title: string,
  initial?: string,
  includeCustomSetup = false,
): Promise<string | undefined> {
  const entries = await providerEntries(runtime, cwd);
  const items: SelectItem<string>[] = entries.map((entry) => {
    const name = PROVIDER_NAMES[entry.provider.id];
    return {
      value: entry.provider.id,
      label: name ? `${name} (${entry.provider.id})` : entry.provider.id,
      description: [
        entry.isDefault ? "default" : "",
        providerAuthLabel(entry),
        entry.provider.baseUrl,
      ].filter(Boolean).join(" · "),
      keywords: [entry.provider.id, entry.provider.baseUrl],
    };
  });
  if (includeCustomSetup) {
    items.push(
      {
        value: `${CUSTOM_PROVIDER_SELECTION_PREFIX}newapi`,
        label: "+ Add NewAPI endpoint",
        description: "custom base URL and API key · OpenAI-compatible API",
        keywords: ["add", "custom", "newapi", "gateway"],
      },
      {
        value: `${CUSTOM_PROVIDER_SELECTION_PREFIX}sub2api`,
        label: "+ Add Sub2API endpoint",
        description: "custom base URL and API key · native Anthropic Messages",
        keywords: ["add", "custom", "sub2api", "gateway", "anthropic"],
      },
    );
  }
  const initialValue =
    initial && items.some((item) => item.value === initial)
      ? initial
      : entries.find((entry) => entry.isDefault)?.provider.id;
  return selectItem(title, items, {
    ...(initialValue ? { initialValue } : {}),
    emptyMessage: "No Provider matches this search",
  });
}

async function chooseCustomProviderFormat(
  initial?: string,
): Promise<CustomProviderFormat | undefined> {
  return selectItem<CustomProviderFormat>(
    "Choose the compatible API format",
    [
      {
        value: "newapi",
        label: "NewAPI",
        description: "OpenAI Chat Completions and GET /models",
        keywords: ["newapi", "openai", "chat", "completions"],
      },
      {
        value: "sub2api",
        label: "Sub2API",
        description: "Anthropic Messages with an OpenAI-compatible model catalog",
        keywords: ["sub2api", "anthropic", "messages", "claude"],
      },
    ],
    {
      ...(CUSTOM_PROVIDER_FORMATS.includes(initial as CustomProviderFormat)
        ? { initialValue: initial as CustomProviderFormat }
        : {}),
    },
  );
}

async function configureCustomProvider(
  runtime: Runtime,
  cwd: string,
  requestedFormat?: string,
  initialId?: string,
): Promise<string | undefined> {
  const normalizedFormat = requestedFormat?.trim().toLowerCase();
  const format = CUSTOM_PROVIDER_FORMATS.includes(
      normalizedFormat as CustomProviderFormat,
    )
    ? normalizedFormat as CustomProviderFormat
    : await chooseCustomProviderFormat(normalizedFormat);
  if (!format) return undefined;

  const suggestedId = initialId?.trim().toLowerCase() || format;
  const enteredId = await ask(`Provider ID [${suggestedId}]`);
  const providerId = (enteredId || suggestedId).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(providerId)) {
    throw new Error(
      "Provider ID must start with a letter or number and contain only letters, numbers, dots, underscores, or dashes.",
    );
  }

  const root = await runtime.worktrees.resolveWorkspaceRoot(cwd);
  const existing = (await runtime.config.listProviders(root, false))
    .providers[providerId];
  const enteredBaseUrl = await ask(
    `Base URL including the API prefix${existing?.baseUrl ? ` [${existing.baseUrl}]` : " (for example https://gateway.example/v1)"}`,
  );
  const requestedBaseUrl = enteredBaseUrl.trim() || existing?.baseUrl;
  if (!requestedBaseUrl) {
    process.stdout.write("Provider setup cancelled; a base URL is required.\n");
    return undefined;
  }
  const baseUrl = normalizeBaseUrl(
    requestedBaseUrl,
    `Provider ${providerId} base URL`,
  );

  const existingApiKey = await runtime.auth.getApiKey(providerId);
  const apiKey = await readSecret(
    existingApiKey
      ? `API key for ${providerId} (leave empty to keep the saved key)`
      : `API key for ${providerId}`,
  );
  if (!apiKey && !existingApiKey) {
    process.stdout.write("Provider setup cancelled; an API key is required.\n");
    return undefined;
  }

  const profilePath = await runtime.config.saveUserProvider(
    providerId,
    customProviderProfile(format, baseUrl),
  );
  if (apiKey) await runtime.auth.login(providerId, apiKey, "manual");
  process.stdout.write(
    `Connected ${providerId} using the ${format} format. Endpoint saved in ${profilePath}; API key saved separately in the VEX auth store.\n`,
  );
  return providerId;
}

function setSessionProvider(
  routing: InteractiveRoutingState,
  provider: string,
): void {
  if (routing.provider && routing.provider !== provider) delete routing.model;
  routing.provider = provider;
}

function formatInteractiveRouting(
  routing: InteractiveRoutingState,
  mode: VexWorkMode,
): string {
  const defaults = `default: ${routing.provider ?? "configured Provider"}/${routing.model ?? "configured model"}`;
  const roles = MODEL_ROLES.flatMap((role) => {
    const route = routing.roleRoutes[role];
    return route
      ? [`${role}: ${route.provider ?? routing.provider ?? "default"}/${route.model ?? routing.model ?? "default"}`]
      : [];
  });
  return [
    "Model routing (saved in ~/.vex/routing.json):",
    `session mode: ${mode}`,
    defaults,
    ...roles,
  ].join("\n");
}

async function assertProviderExists(
  runtime: Runtime,
  cwd: string,
  provider: string,
): Promise<void> {
  await requireProviderEntry(runtime, cwd, provider);
}

async function loginToProvider(
  runtime: Runtime,
  cwd: string,
  requestedProvider?: string,
  requestedMethod?: string,
): Promise<string | undefined> {
  const providerId = requestedProvider?.trim().toLowerCase() ||
    await chooseProvider(runtime, cwd, "Choose a Provider", undefined, true);
  const normalizedMethod = requestedMethod?.trim().toLowerCase();
  if (!providerId) return undefined;
  if (providerId.startsWith(CUSTOM_PROVIDER_SELECTION_PREFIX)) {
    return configureCustomProvider(
      runtime,
      cwd,
      providerId.slice(CUSTOM_PROVIDER_SELECTION_PREFIX.length),
    );
  }
  if (providerId === "add") {
    if (
      normalizedMethod &&
      !CUSTOM_PROVIDER_FORMATS.includes(normalizedMethod as CustomProviderFormat)
    ) {
      throw new Error("Unknown custom Provider format. Use newapi or sub2api.");
    }
    return configureCustomProvider(runtime, cwd, normalizedMethod);
  }
  const existingEntry = (await providerEntries(runtime, cwd)).find(
    (candidate) => candidate.provider.id === providerId,
  );
  if (
    normalizedMethod === "setup" ||
    (!existingEntry && CUSTOM_PROVIDER_FORMATS.includes(
      providerId as CustomProviderFormat,
    ))
  ) {
    return configureCustomProvider(
      runtime,
      cwd,
      CUSTOM_PROVIDER_FORMATS.includes(providerId as CustomProviderFormat)
        ? providerId
        : undefined,
      providerId,
    );
  }
  const entry = await requireProviderEntry(runtime, cwd, providerId);
  if (entry.auth === "keyless") {
    process.stdout.write(
      `${entry.provider.id} is ready; this Provider does not require login.\n`,
    );
    return entry.provider.id;
  }
  if (entry.auth === "environment" && !requestedMethod) {
    process.stdout.write(
      `${entry.provider.id} is already authenticated via ${entry.provider.apiKeyEnv}.\n`,
    );
    return entry.provider.id;
  }
  if (entry.auth === "saved" && !requestedMethod) {
    process.stdout.write(
      `${entry.provider.id} is already connected with ${providerAuthLabel(entry)}.\n`,
    );
    return entry.provider.id;
  }

  let method: ProviderLoginMethod = "api-key";
  if (entry.provider.id === "openai") {
    if (requestedMethod) {
      const normalized = requestedMethod.trim().toLowerCase();
      if (
        normalized === "oauth" ||
        normalized === "browser" ||
        normalized === "web" ||
        normalized === "chatgpt"
      ) {
        method = "oauth";
      } else if (
        normalized === "api-key" ||
        normalized === "key" ||
        normalized === "manual"
      ) {
        method = "api-key";
      } else {
        throw new Error(
          `Unknown OpenAI login method: ${requestedMethod}. Use oauth or api-key.`,
        );
      }
    } else {
      const selected = await selectItem<ProviderLoginMethod>(
        "How do you want to connect OpenAI?",
        [
          {
            value: "oauth",
            label: "Sign in with ChatGPT (recommended)",
            description: "Open the browser and authorize VEX; no API key is required",
            keywords: ["oauth", "browser", "web", "chatgpt", "openai", "login"],
          },
          {
            value: "api-key",
            label: "Paste API key",
            description: "Use an API key you already created",
            keywords: ["api", "key", "manual"],
          },
        ],
        { initialValue: "oauth" },
      );
      if (!selected) return undefined;
      method = selected;
    }
  } else if (requestedMethod) {
    const normalized = requestedMethod.trim().toLowerCase();
    if (
      normalized === "oauth" ||
      normalized === "browser" ||
      normalized === "web" ||
      normalized === "chatgpt"
    ) {
      throw new Error(
        `Browser OAuth login is currently available only for OpenAI.`,
      );
    }
    if (
      normalized !== "api-key" &&
      normalized !== "key" &&
      normalized !== "manual"
    ) {
      throw new Error(
        `Unknown login method: ${requestedMethod}. Use api-key.`,
      );
    }
  }

  if (method === "oauth") {
    const proxy = describeProxyForUrl(OPENAI_OAUTH_ISSUER);
    process.stdout.write(
      `Opening your browser for ChatGPT authorization...${proxy ? `\nOAuth network: ${proxy}` : ""}\n`,
    );
    const tokens = await loginWithOpenAiBrowser({
      onAuthorizationUrl(url) {
        process.stdout.write(
          `Complete authorization in the browser. If it does not open, visit:\n${url}\n`,
        );
      },
      onBrowserOpenError(error) {
        process.stdout.write(
          `VEX could not open the browser automatically: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      },
    });
    await runtime.auth.loginOAuth("openai", tokens);
    process.stdout.write(
      "Connected to OpenAI with ChatGPT OAuth. VEX will refresh this login automatically; no API key was entered.\n",
    );
    return entry.provider.id;
  }

  const apiKey = await readSecret(`API key for ${entry.provider.id}`);
  if (!apiKey) {
    process.stdout.write("Login cancelled.\n");
    return undefined;
  }
  await runtime.auth.login(
    entry.provider.id,
    apiKey,
    "manual",
  );
  process.stdout.write(
    `Connected to ${entry.provider.id}. Credentials saved in the VEX auth store.\n`,
  );
  return entry.provider.id;
}

async function logoutFromProvider(
  runtime: Runtime,
  cwd: string,
  requestedProvider?: string,
): Promise<string | undefined> {
  let providerId = requestedProvider?.trim().toLowerCase();
  if (!providerId) {
    const saved = await runtime.auth.loggedInProviders();
    if (saved.length === 0) {
      process.stdout.write("No saved Provider logins.\n");
      return undefined;
    }
    const entries = new Map(
      (await providerEntries(runtime, cwd)).map((entry) => [
        entry.provider.id,
        entry,
      ]),
    );
    providerId = await selectItem(
      "Disconnect a Provider",
      saved.map((id): SelectItem<string> => {
        const entry = entries.get(id);
        const name = PROVIDER_NAMES[id];
        return {
          value: id,
          label: name ? `${name} (${id})` : id,
          ...(entry
            ? { description: entry.provider.baseUrl }
            : { description: "saved login (profile no longer configured)" }),
          keywords: [id],
        };
      }),
    );
  }
  if (!providerId) return undefined;
  const removed = await runtime.auth.logout(providerId);
  process.stdout.write(
    removed
      ? `Disconnected from ${providerId}.\n`
      : `No saved login for ${providerId}.\n`,
  );
  return providerId;
}

async function ensureProviderAccess(
  runtime: Runtime,
  cwd: string,
  providerId: string,
): Promise<boolean> {
  const entry = await requireProviderEntry(runtime, cwd, providerId);
  if (entry.auth !== "missing") return true;
  if (!(await confirm(`${providerId} needs authentication. Connect now?`))) {
    return false;
  }
  return Boolean(await loginToProvider(runtime, cwd, providerId));
}

interface SelectedModel {
  provider: string;
  model: string;
  target?: ModelTarget;
}

export type ModelTarget = "session-default" | ModelRole;
type ModelTargetMode = "session-or-role" | "role-only";
export type ModelTargetRoutes = Partial<
  Record<ModelTarget, { provider?: string; model?: string }>
>;

interface ChooseModelOptions {
  requestedProvider?: string;
  initialProvider?: string;
  initialModel?: string;
  initialQuery?: string;
  targetMode?: ModelTargetMode;
  targetRoutes?: ModelTargetRoutes;
  continueAfterTargetAssignment?: boolean;
  onTargetAssigned?(
    selection: SelectedModel & { target: ModelTarget },
  ): string | void | Promise<string | void>;
  onCatalogs?(catalogs: readonly ProviderModelCatalog[]): void;
}

function routeConfigured(
  route: { provider?: string; model?: string } | undefined,
): boolean {
  return Boolean(route?.provider || route?.model);
}

function effectiveTargetRoute(
  target: ModelTarget,
  routes: ModelTargetRoutes,
): { provider?: string; model?: string } | undefined {
  const direct = routes[target];
  const defaults = routes["session-default"];
  if (target === "session-default") return direct;
  if (!routeConfigured(direct) && !routeConfigured(defaults)) return undefined;
  const provider = direct?.provider ?? defaults?.provider;
  const model = direct?.model ?? defaults?.model;
  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
  };
}

function routeLabel(route: { provider?: string; model?: string }): string {
  return `${route.provider ?? "default Provider"}/${route.model ?? "default model"}`;
}

function assignedModelTargets(
  routes: ModelTargetRoutes,
  provider: string,
  model: string,
): string[] {
  return (["session-default", ...MODEL_ROLES] as ModelTarget[]).flatMap(
    (target) => {
      if (!routeConfigured(routes[target])) return [];
      const effective = effectiveTargetRoute(target, routes);
      return effective?.provider === provider && effective.model === model
        ? [target === "session-default" ? "default" : target]
        : [];
    },
  );
}

function assignmentSummary(targets: readonly string[]): string {
  if (targets.length <= 4) return targets.join(", ");
  return `${targets.slice(0, 3).join(", ")} +${targets.length - 3}`;
}

export function modelTargetItems(
  includeSessionDefault: boolean,
  routes: ModelTargetRoutes = {},
): SelectItem<ModelTarget>[] {
  const defaults: SelectItem<ModelTarget>[] = includeSessionDefault
    ? [{
        value: "session-default",
        label: "Session default",
        get description() {
          const route = routes["session-default"];
          return [
            routeConfigured(route) ? `current ${routeLabel(route!)}` : "",
            "used by every role without its own override",
          ].filter(Boolean).join(" · ");
        },
        keywords: ["default", "all", "session"],
      }]
    : [];
  return [
    ...defaults,
    ...MODEL_ROLES.map((role): SelectItem<ModelTarget> => {
      return {
        value: role,
        label: role,
        get description() {
          const direct = routes[role];
          const effective = effectiveTargetRoute(role, routes);
          const current = effective
            ? `${routeConfigured(direct) ? "current" : "inherits"} ${routeLabel(effective)}`
            : "";
          return [current, ROLE_DESCRIPTIONS[role]].filter(Boolean).join(" · ");
        },
        keywords: [role, ROLE_DESCRIPTIONS[role]],
      };
    }),
  ];
}

function modelLabel(model: ProviderModel): string {
  return model.displayName && model.displayName !== model.id
    ? `${model.displayName} (${model.id})`
    : model.id;
}

function modelDescription(model: ProviderModel): string {
  return [
    model.description ?? "",
    model.ownedBy && model.ownedBy !== model.provider
      ? `owner ${model.ownedBy}`
      : "",
    model.maxInputTokens
      ? `${model.maxInputTokens.toLocaleString("en-US")} input tokens`
      : "",
    model.maxOutputTokens
      ? `${model.maxOutputTokens.toLocaleString("en-US")} output tokens`
      : "",
    model.capabilities?.slice(0, 4).join(", ") ?? "",
  ].filter(Boolean).join(" · ");
}

async function chooseModel(
  runtime: Runtime,
  cwd: string,
  options: ChooseModelOptions = {},
): Promise<SelectedModel | undefined> {
  const requestedProvider = options.requestedProvider?.trim().toLowerCase();
  if (requestedProvider) {
    await assertProviderExists(runtime, cwd, requestedProvider);
    if (!(await ensureProviderAccess(runtime, cwd, requestedProvider))) {
      return undefined;
    }
  }

  const result = await loadProviderCatalogs(runtime, cwd, requestedProvider);
  options.onCatalogs?.(result.catalogs);
  const catalogs = new Map(
    result.catalogs.map((catalog) => [catalog.provider.id, catalog]),
  );
  const failures = new Map(
    result.failures.map((failure) => [failure.provider, failure.error]),
  );
  const panes: ProviderModelPane<SelectedModel>[] = result.entries.map(
    (entry) => {
      const catalog = catalogs.get(entry.provider.id);
      const failure = failures.get(entry.provider.id);
      const models: SelectItem<SelectedModel>[] = (catalog?.models ?? []).map(
        (model) => {
          const baseDescription = modelDescription(model);
          return {
            value: { provider: entry.provider.id, model: model.id },
            label: modelLabel(model),
            get description() {
              const targets = assignedModelTargets(
                options.targetRoutes ?? {},
                entry.provider.id,
                model.id,
              );
              return [
                targets.length > 0
                  ? `assigned: ${assignmentSummary(targets)}`
                  : "",
                baseDescription,
              ].filter(Boolean).join(" · ");
            },
            keywords: [
              entry.provider.id,
              model.id,
              model.displayName ?? "",
              model.description ?? "",
              model.ownedBy ?? "",
              ...(model.capabilities ?? []),
            ],
          };
        },
      );
      const name = PROVIDER_NAMES[entry.provider.id];
      return {
        id: entry.provider.id,
        label: name ? `${name} [${entry.provider.id}]` : entry.provider.id,
        description: catalog
          ? `${models.length} model${models.length === 1 ? "" : "s"} · ${providerAuthLabel(entry)}`
          : failure
            ? `catalog unavailable · ${failure}`
            : `${providerAuthLabel(entry)} · use /provider ${entry.provider.id}`,
        models,
      };
    },
  );
  const itemCount = panes.reduce((count, pane) => count + pane.models.length, 0);
  if (itemCount === 0) {
    for (const failure of result.failures) {
      process.stdout.write(
        `Could not load ${failure.provider}'s model catalog: ${failure.error}\n`,
      );
    }
    const skipped = result.skipped.length > 0
      ? ` Connect a Provider first: ${result.skipped.join(", ")}.`
      : "";
    process.stdout.write(`No Provider returned a selectable model.${skipped}\n`);
    return undefined;
  }
  const initialValue = panes.flatMap((pane) => pane.models).find(
    (item) =>
      item.value.model === options.initialModel &&
      (!options.initialProvider || item.value.provider === options.initialProvider),
  )?.value;
  const preferredProvider = requestedProvider ??
    initialValue?.provider ??
    options.initialProvider;
  const initialProvider = panes.find(
    (pane) => pane.id === preferredProvider && pane.models.length > 0,
  )?.id ?? panes.find((pane) => pane.models.length > 0)?.id;
  const pickerTitle = requestedProvider
    ? `Choose a model from ${PROVIDER_NAMES[requestedProvider] ?? requestedProvider}`
    : "Choose a Provider and model";
  const pickerOptions = {
    ...(initialProvider ? { initialProvider } : {}),
    ...(initialValue ? { initialValue } : {}),
    ...(options.initialQuery ? { initialQuery: options.initialQuery } : {}),
    maxVisible: 14,
    emptyMessage: "No matching models for this Provider",
  };
  if (options.targetMode) {
    const includeSessionDefault = options.targetMode === "session-or-role";
    const targetBehavior = options.continueAfterTargetAssignment ||
        options.onTargetAssigned
      ? {
          continueAfterAssign: options.continueAfterTargetAssignment ?? false,
          onAssign(selection: {
            model: SelectedModel;
            target: ModelTarget;
          }) {
            return options.onTargetAssigned?.({
              ...selection.model,
              target: selection.target,
            });
          },
        }
      : undefined;
    const selected = await selectProviderModelAndTarget<SelectedModel, ModelTarget>(
      pickerTitle,
      panes,
      {
        title: includeSessionDefault
          ? "Choose the model target"
          : "Choose an Agent role",
        items: modelTargetItems(includeSessionDefault, options.targetRoutes),
        initialValue: includeSessionDefault
          ? "session-default"
          : MODEL_ROLES[0],
        assignedValues: Object.entries(options.targetRoutes ?? {}).flatMap(
          ([target, route]) =>
            routeConfigured(route) ? [target as ModelTarget] : [],
        ),
      },
      pickerOptions,
      targetBehavior,
    );
    return selected
      ? { ...selected.model, target: selected.target }
      : undefined;
  }
  return selectProviderModel(pickerTitle, panes, pickerOptions);
}

function applySelectedModel(
  routing: InteractiveRoutingState,
  selected: SelectedModel,
  target: ModelTarget,
): string {
  if (target === "session-default") {
    setSessionProvider(routing, selected.provider);
    routing.model = selected.model;
    return `Session model: ${selected.provider}/${selected.model}`;
  }
  routing.roleRoutes[target] = {
    provider: selected.provider,
    model: selected.model,
  };
  return `${target} routed to ${selected.provider}/${selected.model}`;
}

async function configureModelRoutes(
  runtime: Runtime,
  cwd: string,
  routing: InteractiveRoutingState,
  options: ChooseModelOptions & { targetMode: ModelTargetMode },
): Promise<string[]> {
  const updates: string[] = [];
  const targetRoutes: ModelTargetRoutes = {
    ...(routing.provider || routing.model
      ? {
          "session-default": {
            ...(routing.provider ? { provider: routing.provider } : {}),
            ...(routing.model ? { model: routing.model } : {}),
          },
        }
      : {}),
    ...Object.fromEntries(
      Object.entries(routing.roleRoutes).map(([role, route]) => [
        role,
        { ...route },
      ]),
    ),
  };
  const selected = await chooseModel(runtime, cwd, {
    ...options,
    targetRoutes,
    continueAfterTargetAssignment: true,
    async onTargetAssigned(assignment) {
      await runtime.config.saveUserModelRoute(
        assignment.target,
        assignment.provider,
        assignment.model,
      );
      const message = applySelectedModel(
        routing,
        assignment,
        assignment.target,
      );
      targetRoutes[assignment.target] = {
        provider: assignment.provider,
        model: assignment.model,
      };
      updates.push(message);
      return message;
    },
  });
  if (selected?.target) {
    updates.push(applySelectedModel(routing, selected, selected.target));
  }
  return updates;
}

function writeModelRouteUpdates(updates: readonly string[]): void {
  if (updates.length === 0) return;
  process.stdout.write(
    `Model routing updated:\n${updates.map((update) => `  ${update}`).join("\n")}\n`,
  );
}

async function chooseRole(initial?: string): Promise<ModelRole | undefined> {
  return selectItem(
    "Choose a role to route",
    MODEL_ROLES.map((role): SelectItem<ModelRole> => ({
      value: role,
      label: role,
      description: ROLE_DESCRIPTIONS[role],
      keywords: [role, ROLE_DESCRIPTIONS[role]],
    })),
    {
      ...(initial && MODEL_ROLES.includes(initial as ModelRole)
        ? { initialValue: initial as ModelRole }
        : {}),
    },
  );
}

async function chooseWorkMode(
  initial: VexWorkMode,
): Promise<VexWorkMode | undefined> {
  return selectItem(
    "Choose the session work mode",
    VEX_WORK_MODES.map((mode): SelectItem<VexWorkMode> => ({
      value: mode,
      label: mode,
      description: MODE_DESCRIPTIONS[mode],
      keywords: [mode, MODE_DESCRIPTIONS[mode]],
    })),
    { initialValue: initial },
  );
}

function applyInteractiveRouting(
  invocation: CliInvocation,
  routing: InteractiveRoutingState,
): CliInvocation {
  if (
    invocation.command !== "run" &&
    invocation.command !== "plan" &&
    invocation.command !== "auto" &&
    invocation.command !== "chat" &&
    invocation.command !== "assess" &&
    invocation.command !== "code-review" &&
    invocation.command !== "config"
  ) {
    return invocation;
  }
  return {
    ...invocation,
    options: {
      ...invocation.options,
      ...(routing.provider ? { provider: routing.provider } : {}),
      ...(routing.model ? { model: routing.model } : {}),
      ...(Object.keys(routing.roleRoutes).length > 0
        ? { roleRoutes: routing.roleRoutes }
        : {}),
    },
  };
}

async function interactive(runtime: Runtime, cwd: string): Promise<void> {
  const savedRouting = await runtime.config.userRouting();
  const routing: InteractiveRoutingState = {
    ...(savedRouting.defaultProvider
      ? { provider: savedRouting.defaultProvider }
      : {}),
    ...(savedRouting.defaultModel ? { model: savedRouting.defaultModel } : {}),
    roleRoutes: Object.fromEntries(
      Object.entries(savedRouting.agents).map(([role, route]) => [
        role,
        { ...route },
      ]),
    ),
  };
  const completionContext: InteractiveCompletionContext = {
    providers: (await providerEntries(runtime, cwd)).map(
      (entry) => entry.provider.id,
    ),
    models: [],
  };
  const rememberCatalogs = (catalogs: readonly ProviderModelCatalog[]) => {
    const models = new Map(
      completionContext.models.map((model) => [
        `${model.provider}\u0000${model.model}`,
        model,
      ]),
    );
    for (const catalog of catalogs) {
      for (const model of catalog.models) {
        models.set(`${catalog.provider.id}\u0000${model.id}`, {
          provider: catalog.provider.id,
          model: model.id,
        });
      }
    }
    completionContext.models = [...models.values()];
  };
  const completer = createInteractiveCompleter(completionContext);
  const hintProvider = createInteractiveHintProvider(completionContext);
  let mode: VexWorkMode = "auto";
  clearAndRender(renderHome(await repositoryView(runtime, cwd)));
  while (true) {
    const action = parseInteractiveInput(
      await chatPrompt(completer, hintProvider),
    );
    if (action.kind === "empty") continue;
    if (action.kind === "prompt") {
      const command: CliCommand = mode === "review"
        ? "assess"
        : mode === "code-review"
          ? "code-review"
          : mode === "implement"
            ? "run"
            : mode;
      try {
        await execute(
          runtime,
          cwd,
          applyInteractiveRouting(
            {
              command,
              values: [action.text],
              options: { yes: false, json: false, global: false },
            },
            routing,
          ),
        );
      } catch (error) {
        process.stdout.write(
          `VEX: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      continue;
    }
    if (action.kind === "quit") return;
    if (action.kind === "clear") {
      clearAndRender(renderHome(await repositoryView(runtime, cwd)));
      continue;
    }
    if (action.kind === "help") {
      process.stdout.write(`${interactiveHelp()}\n`);
      continue;
    }
    if (action.kind === "routing") {
      process.stdout.write(`${formatInteractiveRouting(routing, mode)}\n`);
      continue;
    }
    if (action.kind === "set-mode") {
      try {
        const selected: VexWorkMode | undefined = action.mode
          ? action.mode as VexWorkMode
          : await chooseWorkMode(mode);
        if (!selected) continue;
        if (!VEX_WORK_MODES.includes(selected)) {
          throw new Error(
            `Unknown mode: ${action.mode}. Use auto, chat, review, code-review, or implement.`,
          );
        }
        mode = selected;
        process.stdout.write(
          `Session mode: ${mode} — ${MODE_DESCRIPTIONS[mode]}\n`,
        );
      } catch (error) {
        process.stdout.write(
          `VEX: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      continue;
    }
    if (action.kind === "set-provider") {
      try {
        const requestedProvider = action.provider || await chooseProvider(
          runtime,
          cwd,
          "Choose the default Provider",
          routing.provider,
          true,
        );
        if (!requestedProvider) continue;
        const selectedProvider = await loginToProvider(
          runtime,
          cwd,
          requestedProvider,
          action.method || undefined,
        );
        if (!selectedProvider) continue;
        setSessionProvider(routing, selectedProvider);
        completionContext.providers = (await providerEntries(runtime, cwd)).map(
          (entry) => entry.provider.id,
        );
        process.stdout.write(`Session Provider: ${selectedProvider}\n`);
      } catch (error) {
        process.stdout.write(
          `VEX: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      continue;
    }
    if (action.kind === "set-model") {
      try {
        const updates = await configureModelRoutes(runtime, cwd, routing, {
          ...(routing.provider ? { initialProvider: routing.provider } : {}),
          ...(routing.model ? { initialModel: routing.model } : {}),
          ...modelSelectionFilter(
            action.model,
            completionContext.providers,
          ),
          targetMode: "session-or-role",
          onCatalogs: rememberCatalogs,
        });
        writeModelRouteUpdates(updates);
      } catch (error) {
        process.stdout.write(
          `VEX: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      continue;
    }
    if (action.kind === "set-route") {
      try {
        if (!action.role && !action.provider && !action.model) {
          const updates = await configureModelRoutes(runtime, cwd, routing, {
            ...(routing.provider ? { initialProvider: routing.provider } : {}),
            ...(routing.model ? { initialModel: routing.model } : {}),
            targetMode: "role-only",
            onCatalogs: rememberCatalogs,
          });
          writeModelRouteUpdates(updates);
          continue;
        }
        const role = action.role
          ? action.role as ModelRole
          : await chooseRole();
        if (!role) continue;
        if (!MODEL_ROLES.includes(role)) {
          throw new Error(`Unknown role: ${action.role}`);
        }
        const provider = action.provider ||
          await chooseProvider(
            runtime,
            cwd,
            `Choose a Provider for ${role}`,
            routing.roleRoutes[role]?.provider ?? routing.provider,
          );
        if (!provider) continue;
        await assertProviderExists(runtime, cwd, provider);
        let model = action.model;
        if (!model) {
          const selected = await chooseModel(runtime, cwd, {
            requestedProvider: provider,
            initialProvider: provider,
            ...(routing.roleRoutes[role]?.model
              ? { initialModel: routing.roleRoutes[role].model }
              : {}),
            onCatalogs: rememberCatalogs,
          });
          if (!selected) continue;
          model = selected.model;
        } else if (!(await ensureProviderAccess(runtime, cwd, provider))) {
          continue;
        }
        routing.roleRoutes[role] = {
          provider,
          model,
        };
        await runtime.config.saveUserModelRoute(role, provider, model);
        process.stdout.write(
          `${role} routed to ${provider}/${model} (saved)\n`,
        );
      } catch (error) {
        process.stdout.write(
          `VEX: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      continue;
    }
    if (action.kind === "unknown") {
      process.stdout.write(
        `Unknown VEX command: ${action.command}. Type /help for commands.\n`,
      );
      continue;
    }
    try {
      if (action.invocation.command === "logout") {
        await logoutFromProvider(runtime, cwd, action.invocation.values[0]);
        continue;
      }
      await execute(
        runtime,
        cwd,
        applyInteractiveRouting(action.invocation, routing),
      );
    } catch (error) {
      process.stdout.write(
        `VEX: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}

async function initializeConfig(cwd: string, global: boolean): Promise<string> {
  const directory = global ? path.join(os.homedir(), ".vex") : path.join(cwd, ".vex");
  const target = path.join(directory, "config.jsonc");
  try {
    await access(target);
    throw new Error(`Configuration already exists: ${target}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Configuration already")) {
      throw error;
    }
  }
  await mkdir(directory, { recursive: true });
  const template = `{
  // VEX calls Providers directly. Secrets stay in environment variables or ~/.vex/auth.json.
  "defaultProvider": "openai",
  "defaultModel": "your-model-id",
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "VEX_API_KEY"
    },
    "anthropic": {
      "protocol": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "requiresAuth": false
    },
    // NewAPI and Sub2API use the same contract when configured with your URL:
    // "newapi": { "baseUrl": "https://newapi.example/v1", "apiKeyEnv": "NEWAPI_API_KEY" },
    // "sub2api": { "protocol": "anthropic-messages", "modelCatalog": "openai", "baseUrl": "https://sub2api.example/v1", "apiKeyEnv": "SUB2API_API_KEY" }
  },
  "agents": {
    "architect": { "provider": "openai", "model": "your-reasoning-model" },
    "backend": { "provider": "local", "model": "your-coding-model" }
  },
  "maxParallelWriters": 2,
  "maxRepairAttempts": ${DEFAULT_MAX_REPAIR_ATTEMPTS},
  "projectCommands": []
}
`;
  await writeFile(target, template, "utf8");
  return target;
}

async function formatProviders(runtime: Runtime, cwd: string): Promise<string> {
  const root = await runtime.worktrees.resolveWorkspaceRoot(cwd);
  const profiles = await runtime.config.listProviders(root, false);
  const savedCredentials = await runtime.auth.savedCredentials();
  const rows = Object.values(profiles.providers).map((provider) => {
    const environmentAuth = provider.apiKeyEnv && process.env[provider.apiKeyEnv];
    const auth = !provider.requiresAuth
      ? "no login required"
      : environmentAuth
        ? `environment:${provider.apiKeyEnv}`
        : savedCredentials[provider.id]?.type === "oauth"
          ? "ChatGPT OAuth"
          : savedCredentials[provider.id]?.type === "api-key"
            ? "API key saved"
          : "not logged in";
    return `${provider.id === profiles.defaultProvider ? "*" : " "} ${provider.id.padEnd(12)} ${provider.protocol.padEnd(25)} catalog:${provider.modelCatalog.padEnd(9)} ${auth.padEnd(24)} ${provider.baseUrl}`;
  });
  return `Provider profiles (* default):\n${rows.join("\n")}`;
}

interface ProviderCatalogLoadResult {
  entries: ProviderEntry[];
  catalogs: ProviderModelCatalog[];
  failures: Array<{ provider: string; error: string }>;
  skipped: string[];
}

async function loadProviderCatalogs(
  runtime: Runtime,
  cwd: string,
  requestedProvider?: string,
): Promise<ProviderCatalogLoadResult> {
  const entries = await providerEntries(runtime, cwd);
  const requestedId = requestedProvider?.trim().toLowerCase();
  const requestedEntry = requestedId
    ? entries.find((entry) => entry.provider.id === requestedId)
    : undefined;
  if (requestedId && !requestedEntry) {
    throw new Error(
      `Unknown Provider: ${requestedId}. Use /providers to list profiles.`,
    );
  }
  const candidates = requestedEntry
    ? [requestedEntry]
    : entries.filter((entry) => entry.auth !== "missing");
  const skipped = requestedEntry
    ? []
    : entries
      .filter((entry) => entry.auth === "missing")
      .map((entry) => entry.provider.id);
  const outcomes = await Promise.all(
    candidates.map(async (entry) => {
      try {
        return {
          ok: true as const,
          catalog: await discoverProviderModels({
            provider: entry.provider,
            auth: runtime.auth,
            environment: process.env,
          }),
        };
      } catch (error) {
        return {
          ok: false as const,
          provider: entry.provider.id,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  return {
    entries: requestedEntry ? [requestedEntry] : entries,
    catalogs: outcomes.flatMap((outcome) =>
      outcome.ok ? [outcome.catalog] : []
    ),
    failures: outcomes.flatMap((outcome) =>
      outcome.ok
        ? []
        : [{ provider: outcome.provider, error: outcome.error }]
    ),
    skipped,
  };
}

async function formatModels(
  runtime: Runtime,
  cwd: string,
  requestedProvider?: string,
): Promise<string> {
  const result = await loadProviderCatalogs(runtime, cwd, requestedProvider);
  const sections = result.catalogs.map((catalog) => {
    const models = catalog.models.map((model) =>
      model.displayName && model.displayName !== model.id
        ? `${model.id} — ${model.displayName}`
        : model.id
    );
    return models.length > 0
      ? `[${catalog.provider.id}] ${catalog.catalogProtocol}\n${models.join("\n")}`
      : `[${catalog.provider.id}] returned no models`;
  });
  if (result.failures.length > 0) {
    sections.push(
      `Unavailable catalogs:\n${result.failures.map((failure) =>
        `${failure.provider}: ${failure.error}`
      ).join("\n")}`,
    );
  }
  if (!requestedProvider && result.skipped.length > 0) {
    sections.push(`Not connected: ${result.skipped.join(", ")}`);
  }
  return sections.length > 0
    ? sections.join("\n\n")
    : "No connected Provider model catalogs are available.";
}

async function execute(
  runtime: Runtime,
  cwd: string,
  invocation: CliInvocation,
): Promise<void> {
  const id = invocation.values[0];
  if (invocation.command === "help") {
    process.stdout.write(help());
    return;
  }
  if (invocation.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (invocation.command === "init") {
    process.stdout.write(
      `Created ${await initializeConfig(cwd, invocation.options.global)}\n`,
    );
    return;
  }
  if (invocation.command === "providers") {
    process.stdout.write(`${await formatProviders(runtime, cwd)}\n`);
    return;
  }
  if (invocation.command === "models") {
    process.stdout.write(
      `${await formatModels(runtime, cwd, invocation.values[0])}\n`,
    );
    return;
  }
  if (invocation.command === "provider") {
    await loginToProvider(
      runtime,
      cwd,
      invocation.values[0],
      invocation.values[1],
    );
    return;
  }
  if (invocation.command === "logout") {
    await logoutFromProvider(runtime, cwd, invocation.values[0]);
    return;
  }
  if (invocation.command === "interactive") {
    await interactive(runtime, cwd);
    return;
  }
  if (
    invocation.command === "auto" ||
    invocation.command === "chat" ||
    invocation.command === "assess" ||
    invocation.command === "code-review"
  ) {
    const prompt = invocation.values.join(" ").trim();
    if (!prompt) throw new Error(`vex ${invocation.command} requires a prompt`);
    const requestedMode: VexWorkMode = invocation.command === "auto"
      ? "auto"
      : invocation.command === "chat"
        ? "chat"
        : invocation.command === "assess"
          ? "review"
          : "code-review";
    if (requestedMode === "auto" && process.stdout.isTTY) {
      process.stdout.write("VEX mode: detecting intent…\n");
    }
    const decision = await runtime.modes.decide(
      cwd,
      prompt,
      requestedMode,
      {
        projectTrusted: invocation.options.projectTrusted ?? false,
        ...(invocation.options.model ? { model: invocation.options.model } : {}),
        ...(invocation.options.provider
          ? { provider: invocation.options.provider }
          : {}),
        ...(invocation.options.roleRoutes
          ? { roleRoutes: invocation.options.roleRoutes }
          : {}),
      },
    );
    process.stdout.write(
      `VEX mode: ${requestedMode === "auto" ? `auto → ${decision.mode}` : decision.mode} (${decision.reason})\n`,
    );
    if (decision.mode === "chat") {
      const response = await runtime.modes.chat(cwd, prompt, {
        projectTrusted: invocation.options.projectTrusted ?? false,
        ...(invocation.options.model ? { model: invocation.options.model } : {}),
        ...(invocation.options.provider
          ? { provider: invocation.options.provider }
          : {}),
        ...(invocation.options.roleRoutes
          ? { roleRoutes: invocation.options.roleRoutes }
          : {}),
      });
      process.stdout.write(`\n${response}\n`);
      return;
    }
    if (decision.mode === "review") {
      process.stdout.write(
        "Starting read-only Scout → Technical Reviewer workflow…\n",
      );
      const report = await runtime.modes.review(cwd, prompt, {
        projectTrusted: invocation.options.projectTrusted ?? false,
        ...(invocation.options.model ? { model: invocation.options.model } : {}),
        ...(invocation.options.provider
          ? { provider: invocation.options.provider }
          : {}),
        ...(invocation.options.roleRoutes
          ? { roleRoutes: invocation.options.roleRoutes }
          : {}),
      });
      process.stdout.write(`\n${formatTechnicalReview(report)}\n`);
      return;
    }
    if (decision.mode === "code-review") {
      process.stdout.write(
        "Starting reviewer-only read-only code review…\n",
      );
      const report = await runtime.modes.codeReview(cwd, prompt, {
        projectTrusted: invocation.options.projectTrusted ?? false,
        ...(invocation.options.model ? { model: invocation.options.model } : {}),
        ...(invocation.options.provider
          ? { provider: invocation.options.provider }
          : {}),
        ...(invocation.options.roleRoutes
          ? { roleRoutes: invocation.options.roleRoutes }
          : {}),
      });
      process.stdout.write(`\n${formatTechnicalReview(report)}\n`);
      return;
    }
    await execute(runtime, cwd, { ...invocation, command: "run" });
    return;
  }
  if (invocation.command === "run" || invocation.command === "plan") {
    const task = invocation.values.join(" ").trim();
    if (!task) throw new Error(`vex ${invocation.command} requires a task`);
    const active = runtime.service.plan(cwd, task, {
      projectTrusted: invocation.options.projectTrusted ?? false,
      ...(invocation.options.securityReview
        ? { securityReview: true }
        : {}),
      ...(invocation.options.model ? { model: invocation.options.model } : {}),
      ...(invocation.options.provider
        ? { provider: invocation.options.provider }
        : {}),
      ...(invocation.options.roleRoutes
        ? { roleRoutes: invocation.options.roleRoutes }
        : {}),
    });
    const planned = await monitor(runtime, cwd, active);
    process.stdout.write(`\n${formatExecutionPlan(planned)}\n`);
    if (invocation.command === "plan") return;
    const approved = invocation.options.yes ||
      (process.stdin.isTTY && (await confirm("Execute this plan?")));
    if (!approved) {
      process.stdout.write(`VEX ${planned.id} remains awaiting confirmation.\n`);
      return;
    }
    const execution = await runtime.service.execute(cwd, planned.id);
    const state = await monitor(runtime, cwd, execution);
    process.stdout.write(`${formatRunState(state)}\n`);
    return;
  }
  if (invocation.command === "status") {
    const state = await runtime.service.status(cwd, id);
    if (!state) throw new Error("No VEX runs found");
    process.stdout.write(
      invocation.options.json
        ? `${JSON.stringify(state, null, 2)}\n`
        : `${process.stdout.isTTY ? renderDashboard(state) : formatRunState(state)}\n`,
    );
    return;
  }
  if (invocation.command === "usage") {
    const state = await runtime.service.status(cwd, id);
    if (!state) throw new Error("No VEX runs found");
    process.stdout.write(
      invocation.options.json
        ? `${JSON.stringify(state.usage, null, 2)}\n`
        : `${formatUsageState(state)}\n`,
    );
    return;
  }
  if (invocation.command === "diff") {
    process.stdout.write(`${await runtime.service.diff(cwd, id)}\n`);
    return;
  }
  if (invocation.command === "resume") {
    const state = await runtime.service.status(cwd, id);
    if (!state) throw new Error("No VEX runs found");
    if (state.status === "awaiting-confirmation") {
      process.stdout.write(`${formatExecutionPlan(state)}\n`);
      const approved = invocation.options.yes ||
        (process.stdin.isTTY && (await confirm("Execute this persisted plan?")));
      if (!approved) return;
    }
    const active = await runtime.service.resume(cwd, state.id);
    process.stdout.write(`${formatRunState(await monitor(runtime, cwd, active))}\n`);
    return;
  }
  if (invocation.command === "review") {
    const active = await runtime.service.review(cwd, id);
    process.stdout.write(`${formatRunState(await monitor(runtime, cwd, active))}\n`);
    return;
  }
  if (invocation.command === "merge") {
    process.stdout.write(`${formatRunState(await runtime.service.merge(cwd, id))}\n`);
    return;
  }
  if (invocation.command === "abort") {
    const runId = await runtime.service.abortRun(cwd, id);
    process.stdout.write(runId ? `Abort requested for VEX ${runId}\n` : "No abortable VEX run\n");
    return;
  }
  if (invocation.command === "cleanup") {
    const count = await runtime.service.cleanup(cwd, id);
    process.stdout.write(`Removed ${count} VEX worktree${count === 1 ? "" : "s"}\n`);
    return;
  }
  if (invocation.command === "config") {
    const root = (await repositoryView(runtime, cwd)).root;
    const config = await runtime.config.resolve(
      root,
      invocation.options.model,
      invocation.options.projectTrusted ?? false,
      {
        ...(invocation.options.provider
          ? { provider: invocation.options.provider }
          : {}),
        ...(invocation.options.roleRoutes
          ? { roleRoutes: invocation.options.roleRoutes }
          : {}),
      },
    );
    process.stdout.write(`${formatResolvedConfig(config)}\n`);
  }
}

export async function runCli(
  argv = process.argv.slice(2),
  cwd = process.cwd(),
): Promise<void> {
  const invocation = parseCliArguments(argv);
  if (invocation.command === "help") {
    process.stdout.write(help());
    return;
  }
  if (invocation.command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  await execute(await createRuntime(), cwd, invocation);
}

export function isDirectExecution(
  entryPath: string | undefined,
  moduleUrl: string,
): boolean {
  if (!entryPath) return false;

  const entry = canonicalExecutablePath(entryPath);
  const modulePath = canonicalExecutablePath(fileURLToPath(moduleUrl));
  return entry === modulePath;
}

function canonicalExecutablePath(filePath: string): string {
  const resolved = path.resolve(filePath);
  let canonical = resolved;
  try {
    canonical = realpathSync.native(resolved);
  } catch {
    // Preserve normal module semantics if the path disappears during startup.
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

if (isDirectExecution(process.argv[1], import.meta.url)) {
  runCli().catch((error) => {
    process.stderr.write(
      `VEX: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
