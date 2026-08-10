import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DEFAULT_MAX_REPAIR_ATTEMPTS } from "./defaults.js";
import { GitClient } from "./git.js";
import {
  MODEL_ROLES,
  type ModelRole,
  type RoleState,
  type RoleStatus,
  type VexRunState,
} from "./types.js";
import { normalizeRunTokenUsage } from "./usage.js";

const roleStatuses = new Set<RoleStatus>([
  "pending",
  "waiting",
  "running",
  "completed",
  "skipped",
  "blocked",
  "failed",
  "aborted",
]);

type RenameOperation = (source: string, target: string) => Promise<void>;
const transientRenameErrors = new Set(["EPERM", "EACCES", "EBUSY"]);
const renameRetryDelaysMs = [20, 40, 80, 160, 250, 250, 250];

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function normalizeRoleState(value: unknown, fallbackAt: string): RoleState {
  const previous = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const status = roleStatuses.has(previous.status as RoleStatus)
    ? previous.status as RoleStatus
    : "pending";
  const normalized = {
    ...previous,
    status,
    attempts:
      typeof previous.attempts === "number" &&
        Number.isInteger(previous.attempts) &&
        previous.attempts >= 0
        ? previous.attempts
        : 0,
    statusChangedAt:
      typeof previous.statusChangedAt === "string"
        ? previous.statusChangedAt
        : typeof previous.finishedAt === "string"
          ? previous.finishedAt
          : typeof previous.startedAt === "string"
            ? previous.startedAt
            : fallbackAt,
    ...(status === "waiting" && typeof previous.waitingFor !== "string"
      ? { waitingFor: "workflow dependency" }
      : {}),
  } as RoleState;
  if (status !== "waiting") delete normalized.waitingFor;
  return normalized;
}

function normalizeState(value: unknown): VexRunState {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid VEX state file");
  }
  const raw = value as Record<string, any>;
  const fallbackAt = raw.updatedAt ?? raw.createdAt ?? new Date().toISOString();
  const roles = Object.fromEntries(
    MODEL_ROLES.map((role) => {
      return [role, normalizeRoleState(raw.roles?.[role], fallbackAt)];
    }),
  );
  const provider = normalizeProvider(raw.provider);
  const defaultProvider = raw.defaultProvider ?? provider.id ?? "openai";
  const providers = Object.fromEntries(
    Object.entries(raw.providers ?? { [defaultProvider]: provider }).map(
      ([id, configured]) => [id, normalizeProvider(configured)],
    ),
  );
  const roleRuntime = Object.fromEntries(
    MODEL_ROLES.map((role) => [
      role,
      {
        ...(raw.roleRuntime?.[role] ?? {}),
        provider:
          raw.roleRuntime?.[role]?.provider ?? defaultProvider,
      },
    ]),
  );
  if (
    raw.schemaVersion === 7 ||
    raw.schemaVersion === 6 ||
    raw.schemaVersion === 5
  ) {
    const events = raw.events ?? [];
    return {
      ...raw,
      schemaVersion: 7,
      roles,
      usage: normalizeRunTokenUsage(raw.usage, roleRuntime),
      maxParallelWriters: raw.maxParallelWriters ?? 2,
      maxRepairAttempts:
        raw.maxRepairAttempts ?? DEFAULT_MAX_REPAIR_ATTEMPTS,
      configuredProjectCommands: raw.configuredProjectCommands ?? [],
      defaultProvider,
      provider,
      providers,
      roleRuntime,
      roleDefinitionHashes: raw.roleDefinitionHashes ?? legacyHashes(),
      projectTrusted: raw.projectTrusted === true,
      commandResults: raw.commandResults ?? [],
      reviewCycles: raw.reviewCycles ?? [],
      findings: raw.findings ?? [],
      events: raw.schemaVersion === 7
        ? events
        : [
            ...events,
            {
              at: fallbackAt,
              type: "state-migrated",
              message: `Loaded legacy VEX schema ${raw.schemaVersion}`,
              phase: raw.phase ?? "preflight",
            },
          ],
      reviewsApproved: raw.reviewsApproved === true,
    } as VexRunState;
  }
  return {
    ...raw,
    schemaVersion: 7,
    executionRoot: raw.executionRoot ?? raw.root,
    workspaceKind: raw.workspaceKind === "directory" ? "directory" : "git",
    roles,
    usage: normalizeRunTokenUsage(raw.usage, roleRuntime),
    maxParallelWriters: 2,
    maxRepairAttempts: DEFAULT_MAX_REPAIR_ATTEMPTS,
    configuredProjectCommands: [],
    defaultProvider,
    provider,
    providers,
    roleRuntime,
    roleDefinitionHashes: legacyHashes(),
    projectTrusted: false,
    commandResults: [],
    reviewCycles: [],
    findings: [],
    events: [
      {
        at: raw.updatedAt ?? new Date().toISOString(),
        type: "state-migrated",
        message: `Loaded legacy VEX schema ${String(raw.schemaVersion ?? "unknown")}`,
        phase: raw.phase ?? "preflight",
      },
    ],
    reviewsApproved: raw.status === "completed",
  } as unknown as VexRunState;
}

function legacyHashes(): Record<ModelRole, string> {
  return Object.fromEntries(
    MODEL_ROLES.map((role) => [role, "legacy"]),
  ) as Record<ModelRole, string>;
}

function legacyProvider() {
  return {
    id: "openai",
    protocol: "openai-chat-completions" as const,
    modelCatalog: "openai" as const,
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "VEX_API_KEY",
    requiresAuth: true,
    headersEnv: {},
    sendReasoningEffort: false,
    timeoutMs: 120_000,
    maxAgentTurns: 60,
  };
}

function normalizeProvider(value: unknown) {
  const configured = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  const protocol = configured.protocol === "anthropic-messages"
    ? "anthropic-messages" as const
    : "openai-chat-completions" as const;
  return {
    ...legacyProvider(),
    ...configured,
    protocol,
    modelCatalog: configured.modelCatalog === "anthropic"
      ? "anthropic" as const
      : configured.modelCatalog === "openai"
        ? "openai" as const
        : protocol === "anthropic-messages"
          ? "anthropic" as const
          : "openai" as const,
  };
}

export class RunStateStore {
  readonly #runRoots = new Map<string, string>();
  readonly #renameFile: RenameOperation;

  constructor(
    readonly git = new GitClient(),
    readonly directoryName = "vex",
    renameFile: RenameOperation = rename,
  ) {
    this.#renameFile = renameFile;
  }

  async #replaceTemporary(temporary: string, target: string): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.#renameFile(temporary, target);
        return;
      } catch (error) {
        const retryDelay = renameRetryDelaysMs[attempt];
        if (
          retryDelay === undefined ||
          !transientRenameErrors.has(errorCode(error) ?? "")
        ) {
          throw error;
        }
        await delay(retryDelay);
      }
    }
  }

  async runDirectory(root: string, runId: string): Promise<string> {
    const resolvedRoot = path.resolve(root);
    let runsRoot = this.#runRoots.get(resolvedRoot);
    if (!runsRoot) {
      const result = await this.git.run(
        resolvedRoot,
        ["rev-parse", "--git-common-dir"],
        true,
      );
      const commonDirectory = result.stdout.trim();
      if (result.exitCode === 0 && commonDirectory) {
        const absoluteCommonDirectory = path.isAbsolute(commonDirectory)
          ? commonDirectory
          : path.resolve(resolvedRoot, commonDirectory);
        runsRoot = path.join(absoluteCommonDirectory, this.directoryName, "runs");
      } else {
        runsRoot = path.join(resolvedRoot, `.${this.directoryName}`, "runs");
      }
      this.#runRoots.set(resolvedRoot, runsRoot);
    }
    return path.join(runsRoot, runId);
  }

  async save(state: VexRunState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    const directory = await this.runDirectory(state.root, state.id);
    const target = path.join(directory, "state.json");
    const temporary = `${target}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await this.#replaceTemporary(temporary, target);
  }

  async writeArtifact(
    root: string,
    runId: string,
    relativePath: string,
    value: unknown,
  ): Promise<string> {
    const normalized = relativePath.replaceAll("\\", "/");
    if (
      !normalized ||
      normalized.startsWith("/") ||
      /^[a-z]:\//i.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`Unsafe VEX artifact path: ${relativePath}`);
    }
    const target = path.join(await this.runDirectory(root, runId), normalized);
    const temporary = `${target}.tmp`;
    await mkdir(path.dirname(target), { recursive: true });
    const content =
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(temporary, content, "utf8");
    await this.#replaceTemporary(temporary, target);
    return target;
  }

  async load(root: string, runId: string): Promise<VexRunState> {
    const content = await readFile(
      path.join(await this.runDirectory(root, runId), "state.json"),
      "utf8",
    );
    return normalizeState(JSON.parse(content));
  }

  async latest(root: string): Promise<VexRunState | undefined> {
    const sampleRunDirectory = await this.runDirectory(root, "__lookup__");
    const runsDirectory = path.dirname(sampleRunDirectory);
    let runIds: string[];
    try {
      runIds = await readdir(runsDirectory);
    } catch {
      return undefined;
    }

    const states = await Promise.all(
      runIds.map(async (runId) => {
        try {
          return await this.load(root, runId);
        } catch {
          return undefined;
        }
      }),
    );
    return states
      .filter((state): state is VexRunState => state !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }
}
