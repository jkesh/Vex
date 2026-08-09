import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "./git.js";
import { MODEL_ROLES, type ModelRole, type VexRunState } from "./types.js";

function normalizeState(value: unknown): VexRunState {
  if (!value || typeof value !== "object") {
    throw new Error("Invalid VEX state file");
  }
  const raw = value as Record<string, any>;
  const roles = Object.fromEntries(
    MODEL_ROLES.map((role) => {
      const previous = raw.roles?.[role] ?? { status: "pending" };
      return [role, { attempts: previous.attempts ?? 0, ...previous }];
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
  if (raw.schemaVersion === 5) {
    return {
      ...raw,
      roles,
      maxParallelWriters: raw.maxParallelWriters ?? 2,
      maxRepairAttempts: raw.maxRepairAttempts ?? 2,
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
      events: raw.events ?? [],
      reviewsApproved: raw.reviewsApproved === true,
    } as VexRunState;
  }
  return {
    ...raw,
    schemaVersion: 5,
    executionRoot: raw.executionRoot ?? raw.root,
    workspaceKind: raw.workspaceKind === "directory" ? "directory" : "git",
    roles,
    maxParallelWriters: 2,
    maxRepairAttempts: 2,
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
    maxAgentTurns: 40,
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

  constructor(
    readonly git = new GitClient(),
    readonly directoryName = "vex",
  ) {}

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
    await rename(temporary, target);
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
    await rename(temporary, target);
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
