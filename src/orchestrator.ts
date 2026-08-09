import path from "node:path";
import type { VexConfigLoader } from "./config.js";
import {
  ShellProjectCommandRunner,
  type ProjectCommandRunner,
} from "./command-runner.js";
import type { RoleKnowledgeClient } from "./knowledge.js";
import {
  manifestFromArchitect,
  readyImplementationRoles,
  validateExecutionManifest,
} from "./manifest.js";
import { FileOwnershipPolicy, matchesOwnedPath } from "./policy.js";
import { hashRoleDefinitions } from "./roles.js";
import type { RunStateStore } from "./state-store.js";
import {
  MODEL_ROLES,
  type ChangeResult,
  type ExecutionManifest,
  type ModelRole,
  type ReviewCycle,
  type ReviewFinding,
  type ReviewPriority,
  type ReviewReport,
  type RoleAssignment,
  type RoleDefinition,
  type RoleRunResult,
  type RoleState,
  type ScoutReport,
  type VexRunOptions,
  type VexRunState,
  type WriterRole,
  type WorktreeRecord,
} from "./types.js";
import type { WorktreeManager } from "./worktrees.js";

export interface VexOrchestratorDependencies {
  roles: Map<ModelRole, RoleDefinition>;
  runner: {
    run: (
      input: Parameters<import("./types.js").RoleRunner["run"]>[0],
      signal?: AbortSignal,
    ) => Promise<RoleRunResult>;
  };
  knowledge: RoleKnowledgeClient;
  worktrees: WorktreeManager;
  policy: FileOwnershipPolicy;
  store: RunStateStore;
  config: Pick<VexConfigLoader, "resolve">;
  commands?: ProjectCommandRunner;
}

function initialRoleStates(): Record<ModelRole, RoleState> {
  return Object.fromEntries(
    MODEL_ROLES.map((role) => [role, { status: "pending", attempts: 0 }]),
  ) as Record<ModelRole, RoleState>;
}

export function createRunId(now = new Date()): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

function requireRole(
  roles: Map<ModelRole, RoleDefinition>,
  name: ModelRole,
): RoleDefinition {
  const role = roles.get(name);
  if (!role) throw new Error(`Fixed role is not loaded: ${name}`);
  return role;
}

function resultSucceeded(result: RoleRunResult): boolean {
  return (
    result.exitCode === 0 &&
    (result.yield.status === "completed" || result.yield.status === "skipped")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeScout(result: RoleRunResult): ScoutReport {
  const payload = isRecord(result.yield.payload) ? result.yield.payload : {};
  return {
    repositorySummary:
      typeof payload.repositorySummary === "string"
        ? payload.repositorySummary
        : result.yield.summary,
    relevantPaths: stringArray(payload.relevantPaths),
    constraints: stringArray(payload.constraints),
    risks: stringArray(payload.risks),
  };
}

function sameHashes(
  expected: Record<ModelRole, string>,
  actual: Record<ModelRole, string>,
): boolean {
  return MODEL_ROLES.every((role) => expected[role] === actual[role]);
}

function priorityFrom(value: unknown): ReviewPriority {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  if (value === "critical") return 0;
  if (value === "high") return 1;
  if (value === "medium") return 2;
  return 3;
}

function assignmentFor(
  manifest: ExecutionManifest,
  role: WriterRole,
): RoleAssignment {
  const assignment = manifest.assignments.find((item) => item.role === role);
  if (!assignment) throw new Error(`Manifest has no assignment for ${role}`);
  return assignment;
}

export class VexOrchestrator {
  readonly #deps: VexOrchestratorDependencies;
  readonly #commands: ProjectCommandRunner;
  readonly #saveQueues = new Map<string, Promise<void>>();

  constructor(dependencies: VexOrchestratorDependencies) {
    this.#deps = dependencies;
    this.#commands = dependencies.commands ?? new ShellProjectCommandRunner();
  }

  async plan(
    rootCandidate: string,
    task: string,
    runId: string,
    options: VexRunOptions = {},
    signal?: AbortSignal,
  ): Promise<VexRunState> {
    const workspace = await this.#deps.worktrees.inspectWorkspace(rootCandidate);
    const configuration = await this.#deps.config.resolve(
      workspace.root,
      options.model,
      options.projectTrusted ?? false,
      {
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.roleRoutes ? { roleRoutes: options.roleRoutes } : {}),
      },
    );
    const repository = await this.#deps.worktrees.prepareRepository(
      rootCandidate,
      runId,
    );
    const hashes = hashRoleDefinitions(this.#deps.roles);
    const now = new Date().toISOString();
    const state: VexRunState = {
      schemaVersion: 5,
      id: runId,
      task,
      root: repository.root,
      executionRoot: repository.executionRoot,
      workspaceKind: repository.kind,
      ...(repository.fingerprint
        ? { workspaceFingerprint: repository.fingerprint }
        : {}),
      baseBranch: repository.branch,
      baseRef: repository.head,
      status: "created",
      phase: "preflight",
      securityReview: options.securityReview ?? false,
      projectTrusted: options.projectTrusted ?? false,
      defaultProvider: configuration.defaultProvider,
      provider: configuration.provider,
      providers: configuration.providers,
      maxParallelWriters: configuration.maxParallelWriters,
      maxRepairAttempts: configuration.maxRepairAttempts,
      configuredProjectCommands: configuration.projectCommands,
      configurationSources: configuration.sources,
      roleRuntime: configuration.agents,
      roleDefinitionHashes: hashes,
      createdAt: now,
      updatedAt: now,
      activePid: process.pid,
      roles: initialRoleStates(),
      worktrees: [],
      changes: [],
      commandResults: [],
      reviewCycles: [],
      findings: [],
      events: [],
      integratedCommits: [],
      reviewsApproved: false,
    };
    this.#event(state, "run-created", `Planning run ${runId}`);
    await this.#save(state);

    return this.#continuePlanning(state, signal);
  }

  /** Convenience API entrypoint: plan and execute, but never merge. */
  async run(
    rootCandidate: string,
    task: string,
    runId: string,
    options: VexRunOptions = {},
    signal?: AbortSignal,
  ): Promise<VexRunState> {
    const planned = await this.plan(rootCandidate, task, runId, options, signal);
    return this.execute(planned.root, planned.id, signal);
  }

  async #continuePlanning(
    state: VexRunState,
    signal?: AbortSignal,
  ): Promise<VexRunState> {
    try {
      if (!state.scoutReport) {
        await this.#setPhase(state, "discovery", "planning");
        const scout = await this.#runRole(
          state,
          "scout",
          state.executionRoot,
          { baseRef: state.baseRef },
          signal,
          state.roles.scout.attempts > 0,
        );
        state.scoutReport = normalizeScout(scout);
        await this.#deps.store.writeArtifact(
          state.root,
          state.id,
          "scout-report.json",
          state.scoutReport,
        );
      }

      await this.#setPhase(state, "design", "planning");
      const architect = await this.#runRole(
        state,
        "architect",
        state.executionRoot,
        { scout: state.scoutReport },
        signal,
        state.roles.architect.attempts > 0,
      );
      state.manifest = manifestFromArchitect(state.task, architect, {
        runId: state.id,
        repoRoot: state.root,
        baseCommit: state.baseRef,
        projectCommands: state.configuredProjectCommands,
        constraints: state.scoutReport.constraints,
        riskFlags: state.scoutReport.risks,
        roleDefinitionHashes: state.roleDefinitionHashes,
      });
      state.securityReview = state.securityReview || state.manifest.securityReview;
      await this.#deps.store.writeArtifact(
        state.root,
        state.id,
        "manifest.json",
        state.manifest,
      );
      await this.#deps.store.writeArtifact(
        state.root,
        state.id,
        "role-definition-hashes.json",
        state.roleDefinitionHashes,
      );
      await Promise.all([
        this.#deps.store.writeArtifact(
          state.root,
          state.id,
          "command-results.json",
          state.commandResults,
        ),
        this.#deps.store.writeArtifact(
          state.root,
          state.id,
          "review-cycles.json",
          state.reviewCycles,
        ),
        this.#deps.store.writeArtifact(
          state.root,
          state.id,
          "findings.json",
          state.findings,
        ),
      ]);
      state.phase = "approval";
      state.status = "awaiting-confirmation";
      delete state.activePid;
      delete state.error;
      this.#event(
        state,
        "plan-ready",
        "Execution manifest validated; writer roles are waiting for confirmation",
      );
      await this.#save(state);
      return state;
    } catch (error) {
      await this.#markFailed(state, error, signal);
      throw error;
    }
  }

  async execute(
    root: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<VexRunState> {
    const state = await this.#deps.store.load(root, runId);
    if (state.status !== "awaiting-confirmation") {
      throw new Error(
        `VEX ${runId} is ${state.status}; execution requires awaiting-confirmation`,
      );
    }
    const manifest = state.manifest;
    if (!manifest) throw new Error(`VEX ${runId} has no execution manifest`);
    validateExecutionManifest(manifest);
    await this.#assertImmutableRun(state);
    state.approvedAt = new Date().toISOString();
    state.activePid = process.pid;
    delete state.error;
    this.#event(state, "plan-approved", "User approved the execution manifest");
    await this.#save(state);

    try {
      await this.#setPhase(state, "implementation", "running");
      const integration = await this.#deps.worktrees.create(
        state.executionRoot,
        state.id,
        "integrator",
        state.baseRef,
      );
      state.worktrees.push(integration);
      await this.#save(state);

      const owners = new Map<string, WriterRole>();
      const pending = new Set<WriterRole>(["backend", "frontend"]);
      const completed = new Set<WriterRole>();
      while (pending.size > 0) {
        const ready = readyImplementationRoles(manifest, pending, completed);
        if (ready.length === 0) {
          throw new Error("No implementation role is ready; check manifest dependencies");
        }
        const batch = ready.slice(0, state.maxParallelWriters);
        const runnable = batch.filter(
          (role) => !assignmentFor(manifest, role).skipped,
        );
        const skippedChanges: ChangeResult[] = [];
        for (const role of batch) {
          const assignment = assignmentFor(manifest, role);
          if (!assignment.skipped) continue;
          const change = this.#skippedChange(assignment);
          state.roles[role] = {
            ...state.roles[role],
            status: "skipped",
            summary: assignment.objective,
            finishedAt: new Date().toISOString(),
          };
          skippedChanges.push(change);
        }

        const baseRef = await this.#deps.worktrees.head(integration);
        const worktrees: Array<readonly ["backend" | "frontend", WorktreeRecord]> = [];
        for (const role of runnable) {
          const worktree = await this.#deps.worktrees.create(
            state.executionRoot,
            state.id,
            role,
            baseRef,
          );
          state.worktrees.push(worktree);
          worktrees.push([role, worktree]);
        }
        await this.#save(state);
        const settled = await Promise.allSettled(
          worktrees.map(async ([role, worktree]) => {
            const assignment = assignmentFor(manifest, role);
            const result = await this.#runRole(
              state,
              role,
              worktree.path,
              { manifest, assignment, scout: state.scoutReport },
              signal,
            );
            return this.#collectChange(assignment, worktree, result, 0);
          }),
        );
        const rejected = settled.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (rejected) throw rejected.reason;
        const changes = [
          ...skippedChanges,
          ...settled.map(
            (result) => (result as PromiseFulfilledResult<ChangeResult>).value,
          ),
        ];
        for (const role of manifest.integrationOrder) {
          const change = changes.find((item) => item.role === role);
          if (!change) continue;
          const assignment = assignmentFor(manifest, role);
          this.#enforcePolicy(change, owners, assignment.allowedPaths);
          change.changedFiles.forEach((file) => owners.set(file, role));
          state.changes.push(change);
          await this.#deps.worktrees.integrate(integration, change.commits);
          state.integratedCommits.push(...change.commits);
          pending.delete(role);
          completed.add(role);
          await this.#writeChange(state, change);
        }
        await this.#save(state);
      }

      await this.#setPhase(state, "integration", "running");
      await this.#runTestAssignment(state, manifest, integration, owners, signal);
      await this.#setPhase(state, "verification", "running");
      await this.#runProjectCommands(state, integration, signal);

      let approved = false;
      for (let attempt = 0; attempt <= state.maxRepairAttempts; attempt++) {
        const cycle = await this.#runReviewCycle(
          state,
          manifest,
          integration,
          attempt,
          signal,
        );
        if (cycle.approved) {
          approved = true;
          break;
        }
        if (attempt >= state.maxRepairAttempts) break;
        await this.#setPhase(state, "repair", "running");
        await this.#repairFindings(
          state,
          manifest,
          integration,
          owners,
          cycle.findings,
          attempt + 1,
          signal,
        );
        await this.#setPhase(state, "verification", "running");
        await this.#runProjectCommands(state, integration, signal);
      }
      if (!approved) {
        throw new Error(
          `Review still has ${state.findings.length} finding(s) after ${state.maxRepairAttempts} repair attempt(s)`,
        );
      }

      state.integrationRef = await this.#deps.worktrees.head(integration);
      state.phase = "ready-to-merge";
      state.status = "awaiting-merge";
      delete state.activePid;
      state.reviewsApproved = true;
      this.#event(
        state,
        "ready-to-merge",
        "Verification and review passed; explicit /team-merge is required",
      );
      await this.#save(state);
      return state;
    } catch (error) {
      await this.#markFailed(state, error, signal);
      throw error;
    }
  }

  async resume(
    root: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<VexRunState> {
    const state = await this.#deps.store.load(root, runId);
    if (state.status === "awaiting-confirmation") {
      return this.execute(root, runId, signal);
    }
    if (state.status === "awaiting-merge" || state.status === "completed") {
      return state;
    }
    if (state.status !== "failed" && state.status !== "aborted") {
      throw new Error(`VEX ${runId} cannot resume from ${state.status}`);
    }
    await this.#assertImmutableRun(state);
    state.activePid = process.pid;
    if (!state.manifest) return this.#continuePlanning(state, signal);
    const remaining = await this.#deps.worktrees.removeMany(
      state.executionRoot,
      [...state.worktrees].reverse(),
    );
    if (remaining.length > 0) {
      throw new Error(`Cannot resume while ${remaining.length} old worktree(s) remain`);
    }
    state.worktrees = [];
    state.changes = [];
    state.commandResults = [];
    state.reviewCycles = [];
    state.findings = [];
    state.integratedCommits = [];
    delete state.integrationRef;
    delete state.finalRef;
    state.reviewsApproved = false;
    delete state.error;
    delete state.approvedAt;
    for (const role of [
      "backend",
      "frontend",
      "test-engineer",
      "reviewer",
      "security-reviewer",
    ] as const) {
      state.roles[role] = { status: "pending", attempts: state.roles[role].attempts };
    }
    state.phase = "approval";
    state.status = "awaiting-confirmation";
    this.#event(state, "run-resumed", "Reset execution worktrees to the approved manifest");
    await this.#save(state);
    return this.execute(root, runId, signal);
  }

  async review(
    root: string,
    runId: string,
    signal?: AbortSignal,
  ): Promise<VexRunState> {
    const state = await this.#deps.store.load(root, runId);
    if (state.status !== "awaiting-merge" || !state.manifest) {
      throw new Error(`VEX ${runId} must be awaiting-merge before /review`);
    }
    await this.#assertImmutableRun(state);
    state.activePid = process.pid;
    const integration = this.#integrationWorktree(state);
    const cycle = await this.#runReviewCycle(
      state,
      state.manifest,
      integration,
      state.reviewCycles.length,
      signal,
    );
    state.reviewsApproved = cycle.approved;
    if (cycle.approved) {
      state.phase = "ready-to-merge";
      state.status = "awaiting-merge";
      delete state.error;
    } else {
      state.status = "failed";
      state.error = `Review reported ${cycle.findings.length} finding(s)`;
    }
    delete state.activePid;
    await this.#save(state);
    return state;
  }

  async merge(root: string, runId: string): Promise<VexRunState> {
    const state = await this.#deps.store.load(root, runId);
    if (state.status !== "awaiting-merge" || !state.reviewsApproved) {
      throw new Error(`VEX ${runId} is not approved and awaiting an explicit merge`);
    }
    await this.#assertImmutableRun(state);
    const integration = this.#integrationWorktree(state);
    const actualIntegrationRef = await this.#deps.worktrees.head(integration);
    if (state.integrationRef !== actualIntegrationRef) {
      throw new Error(
        `Integration worktree moved from ${state.integrationRef} to ${actualIntegrationRef}`,
      );
    }
    state.phase = "finalize";
    state.status = "running";
    this.#event(state, "merge-started", `Fast-forwarding ${state.baseBranch}`);
    await this.#save(state);
    try {
      if (state.workspaceKind === "directory") {
        if (!state.workspaceFingerprint) {
          throw new Error(`VEX ${runId} has no directory snapshot fingerprint`);
        }
        const runDirectory = await this.#deps.store.runDirectory(
          state.root,
          state.id,
        );
        state.finalRef = await this.#deps.worktrees.mergeIntoDirectory(
          state.root,
          state.workspaceFingerprint,
          integration,
          path.join(runDirectory, "backups", "original"),
        );
      } else {
        state.finalRef = await this.#deps.worktrees.mergeIntoOriginal(
          state.root,
          state.baseRef,
          state.baseBranch,
          integration,
        );
      }
      state.worktrees = await this.#deps.worktrees.removeMany(
        state.executionRoot,
        [...state.worktrees].reverse(),
      );
      if (state.workspaceKind === "directory") {
        await this.#deps.worktrees.removeManagedRepository(state.executionRoot);
      }
      state.phase = "done";
      state.status = "completed";
      this.#event(state, "merge-completed", `Merged ${state.finalRef}`);
      await this.#save(state);
      return state;
    } catch (error) {
      await this.#markFailed(state, error);
      throw error;
    }
  }

  async #runTestAssignment(
    state: VexRunState,
    manifest: ExecutionManifest,
    integration: WorktreeRecord,
    owners: Map<string, WriterRole>,
    signal?: AbortSignal,
  ): Promise<void> {
    const assignment = assignmentFor(manifest, "test-engineer");
    if (assignment.skipped) {
      const change = this.#skippedChange(assignment);
      state.roles["test-engineer"] = {
        ...state.roles["test-engineer"],
        status: "skipped",
        summary: assignment.objective,
        finishedAt: new Date().toISOString(),
      };
      state.changes.push(change);
      await this.#writeChange(state, change);
      await this.#save(state);
      return;
    }
    const integratedHead = await this.#deps.worktrees.head(integration);
    const worktree = await this.#deps.worktrees.create(
      state.executionRoot,
      state.id,
      "test-engineer",
      integratedHead,
    );
    state.worktrees.push(worktree);
    await this.#save(state);
    const result = await this.#runRole(
      state,
      "test-engineer",
      worktree.path,
      { manifest, assignment, changes: state.changes },
      signal,
    );
    const change = await this.#collectChange(assignment, worktree, result, 0);
    this.#enforcePolicy(change, owners, assignment.allowedPaths);
    change.changedFiles.forEach((file) => owners.set(file, "test-engineer"));
    state.changes.push(change);
    await this.#deps.worktrees.integrate(integration, change.commits);
    state.integratedCommits.push(...change.commits);
    await this.#writeChange(state, change);
    await this.#save(state);
  }

  async #runProjectCommands(
    state: VexRunState,
    integration: WorktreeRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    for (const command of state.manifest?.projectCommands ?? []) {
      if (signal?.aborted) throw new DOMException("VEX run aborted", "AbortError");
      const beforeHead = await this.#deps.worktrees.head(integration);
      const result = await this.#commands.run(command, integration.path, signal);
      state.commandResults.push(result);
      await this.#deps.store.writeArtifact(
        state.root,
        state.id,
        "command-results.json",
        state.commandResults,
      );
      await this.#save(state);
      if (result.exitCode !== 0) {
        throw new Error(
          `Project command failed (${result.exitCode}): ${command}\n${result.stderr || result.stdout}`,
        );
      }
      const afterHead = await this.#deps.worktrees.head(integration);
      const dirty = await this.#deps.worktrees.status(integration);
      if (afterHead !== beforeHead || dirty) {
        throw new Error(
          `Project command must leave the integration worktree unchanged: ${command}${afterHead !== beforeHead ? `\nHEAD moved to ${afterHead}` : ""}${dirty ? `\n${dirty}` : ""}`,
        );
      }
    }
  }

  async #runReviewCycle(
    state: VexRunState,
    manifest: ExecutionManifest,
    integration: WorktreeRecord,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<ReviewCycle> {
    await this.#setPhase(state, "review", "running");
    const reports: ReviewCycle["reports"] = {};
    const reviewer = await this.#runRole(
      state,
      "reviewer",
      integration.path,
      { manifest, changes: state.changes, commandResults: state.commandResults },
      signal,
      attempt > 0,
    );
    reports.reviewer = this.#normalizeReview(reviewer, manifest, "reviewer");
    if (state.securityReview) {
      const security = await this.#runRole(
        state,
        "security-reviewer",
        integration.path,
        { manifest, changes: state.changes, commandResults: state.commandResults },
        signal,
        attempt > 0,
      );
      reports["security-reviewer"] = this.#normalizeReview(
        security,
        manifest,
        "security-reviewer",
      );
    } else {
      state.roles["security-reviewer"] = {
        ...state.roles["security-reviewer"],
        status: "skipped",
        summary: "Security review was not requested",
      };
    }
    const findings = Object.values(reports).flatMap((report) => report.findings);
    const approved = Object.values(reports).every((report) => report.approved) &&
      findings.length === 0;
    const cycle: ReviewCycle = {
      attempt,
      reports,
      findings,
      approved,
      createdAt: new Date().toISOString(),
    };
    state.reviewCycles.push(cycle);
    state.findings = findings;
    state.reviewsApproved = approved;
    await this.#deps.store.writeArtifact(
      state.root,
      state.id,
      "review-cycles.json",
      state.reviewCycles,
    );
    await this.#deps.store.writeArtifact(
      state.root,
      state.id,
      "findings.json",
      findings,
    );
    await this.#save(state);
    return cycle;
  }

  #normalizeReview(
    result: RoleRunResult,
    manifest: ExecutionManifest,
    source: "reviewer" | "security-reviewer",
  ): ReviewReport {
    const payload = isRecord(result.yield.payload) ? result.yield.payload : {};
    const rawFindings = Array.isArray(payload.findings) ? payload.findings : [];
    const findings = rawFindings.map((raw, index): ReviewFinding => {
      if (!isRecord(raw)) throw new Error(`${source} finding ${index + 1} is invalid`);
      const file =
        typeof raw.file === "string"
          ? raw.file
          : typeof raw.path === "string"
            ? raw.path
            : undefined;
      const explicitOwner = raw.owner as WriterRole | undefined;
      const inferredOwner = file
        ? manifest.assignments.find((assignment) =>
            assignment.allowedPaths.some((pattern) => matchesOwnedPath(file, pattern)),
          )?.role
        : undefined;
      const owner = explicitOwner ?? inferredOwner;
      if (!owner || !["backend", "frontend", "test-engineer"].includes(owner)) {
        throw new Error(`${source} finding ${index + 1} has no valid owner`);
      }
      const fallback = `Review finding ${index + 1}`;
      const title =
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : typeof raw.message === "string" && raw.message.trim()
            ? raw.message.trim()
            : fallback;
      const explanation =
        typeof raw.explanation === "string" && raw.explanation.trim()
          ? raw.explanation.trim()
          : typeof raw.message === "string" && raw.message.trim()
            ? raw.message.trim()
            : title;
      return {
        owner,
        priority: priorityFrom(raw.priority ?? raw.severity),
        ...(file ? { file } : {}),
        ...(typeof raw.line === "number" && Number.isInteger(raw.line)
          ? { line: raw.line }
          : {}),
        title,
        explanation,
        source,
      };
    });
    return {
      approved: payload.approved === true && findings.length === 0,
      findings,
      summary:
        typeof payload.summary === "string" && payload.summary.trim()
          ? payload.summary.trim()
          : result.yield.summary,
    };
  }

  async #repairFindings(
    state: VexRunState,
    manifest: ExecutionManifest,
    integration: WorktreeRecord,
    owners: Map<string, WriterRole>,
    findings: ReviewFinding[],
    attempt: number,
    signal?: AbortSignal,
  ): Promise<void> {
    const affected = manifest.integrationOrder.filter((role) =>
      findings.some((finding) => finding.owner === role),
    );
    if (affected.length === 0) throw new Error("Review rejected without routable findings");
    for (const role of affected) {
      const assignment = assignmentFor(manifest, role);
      let worktree = state.worktrees.find((item) => item.owner === role);
      if (!worktree) {
        worktree = await this.#deps.worktrees.create(
          state.executionRoot,
          state.id,
          role,
          await this.#deps.worktrees.head(integration),
        );
        state.worktrees.push(worktree);
        await this.#save(state);
      }
      const before = await this.#deps.worktrees.head(worktree);
      const result = await this.#runRole(
        state,
        role,
        worktree.path,
        {
          manifest,
          assignment,
          repairAttempt: attempt,
          findings: findings.filter((finding) => finding.owner === role),
          instruction:
            "Fix only the routed findings, commit the repair, and preserve assignment ownership.",
        },
        signal,
        true,
      );
      const change = await this.#collectChange(
        assignment,
        worktree,
        result,
        attempt,
        before,
      );
      if (change.commits.length === 0) {
        throw new Error(`${role} did not commit a repair for routed findings`);
      }
      this.#enforcePolicy(change, owners, assignment.allowedPaths, role);
      change.changedFiles.forEach((file) => owners.set(file, role));
      await this.#deps.worktrees.integrate(integration, change.commits);
      state.integratedCommits.push(...change.commits);
      state.changes.push(change);
      await this.#writeChange(state, change);
      await this.#save(state);
    }
  }

  async #runRole(
    state: VexRunState,
    name: ModelRole,
    cwd: string,
    context: Record<string, unknown>,
    signal?: AbortSignal,
    resumeSession = false,
  ): Promise<RoleRunResult> {
    if (signal?.aborted) throw new DOMException("VEX run aborted", "AbortError");
    const previous = state.roles[name];
    const definition = requireRole(this.#deps.roles, name);
    const readOnlyHead = !definition.writes
      ? await this.#deps.worktrees.git.output(cwd, ["rev-parse", "HEAD"])
      : undefined;
    const startedAt = new Date().toISOString();
    const attempts = previous.attempts + 1;
    state.roles[name] = { status: "running", attempts, startedAt };
    this.#event(state, "role-started", `${name} attempt ${attempts}`, name);
    await this.#save(state);
    const runDirectory = await this.#deps.store.runDirectory(state.root, state.id);
    const knowledge = await this.#deps.knowledge.retrieve({
      role: name,
      query: state.task,
      cwd,
      runId: state.id,
      ...(signal ? { signal } : {}),
    });
    const result = await this.#deps.runner.run(
      {
        runId: state.id,
        role: definition,
        task: state.task,
        cwd,
        context: {
          repositoryRoot: state.root,
          runDirectory,
          projectTrusted: state.projectTrusted,
          ...context,
        },
        knowledge,
        runtime: state.roleRuntime[name],
        provider:
          state.providers[state.roleRuntime[name].provider] ?? state.provider,
        ...(resumeSession ? { resumeSession: true } : {}),
      },
      signal,
    );
    if (!definition.writes) {
      const currentHead = await this.#deps.worktrees.git.output(cwd, [
        "rev-parse",
        "HEAD",
      ]);
      const dirty = await this.#deps.worktrees.git.output(cwd, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ]);
      if (currentHead !== readOnlyHead || dirty) {
        throw new Error(
          `${name} violated read-only policy${currentHead !== readOnlyHead ? ` by moving HEAD to ${currentHead}` : ""}${dirty ? `:\n${dirty}` : ""}`,
        );
      }
    }
    await this.#deps.store.writeArtifact(
      state.root,
      state.id,
      `logs/${name}-${attempts}.jsonl`,
      result.rawOutput,
    );
    await this.#deps.store.writeArtifact(
      state.root,
      state.id,
      `results/${name}-${attempts}.json`,
      result.yield,
    );
    state.roles[name] = {
      status: resultSucceeded(result) ? result.yield.status : "failed",
      attempts,
      startedAt,
      finishedAt: new Date().toISOString(),
      summary: result.yield.summary,
      ...(resultSucceeded(result)
        ? {}
        : { error: result.stderr || result.yield.summary }),
    };
    this.#event(
      state,
      "role-finished",
      `${name} ${state.roles[name].status}: ${result.yield.summary}`,
      name,
    );
    await this.#save(state);
    if (!resultSucceeded(result)) throw new Error(`${name} failed: ${result.yield.summary}`);
    return result;
  }

  async #collectChange(
    assignment: RoleAssignment,
    worktree: WorktreeRecord,
    result: RoleRunResult,
    attempt: number,
    baseline = worktree.baseRef,
  ): Promise<ChangeResult> {
    const dirty = await this.#deps.worktrees.status(worktree);
    if (dirty) throw new Error(`${assignment.role} left uncommitted changes:\n${dirty}`);
    const commits = await this.#deps.worktrees.commitsBetween(worktree, baseline);
    const changedFiles = await this.#deps.worktrees.changedFilesBetween(
      worktree,
      baseline,
    );
    if (result.yield.status === "completed" && commits.length === 0) {
      result.yield.status = "skipped";
    }
    return {
      assignmentId: assignment.id,
      role: assignment.role,
      attempt,
      status: result.yield.status,
      summary: result.yield.summary,
      commits,
      changedFiles,
      commandResults: [],
      notes: [],
      worktreePath: worktree.path,
    };
  }

  #skippedChange(assignment: RoleAssignment): ChangeResult {
    return {
      assignmentId: assignment.id,
      role: assignment.role,
      attempt: 0,
      status: "skipped",
      summary: assignment.objective,
      commits: [],
      changedFiles: [],
      commandResults: [],
      notes: ["Skipped by the approved execution manifest"],
      worktreePath: "",
    };
  }

  #enforcePolicy(
    change: ChangeResult,
    owners: ReadonlyMap<string, WriterRole>,
    allowedPaths: readonly string[],
    repairingOwner?: WriterRole,
  ): void {
    const visibleOwners = repairingOwner
      ? new Map([...owners].filter(([, owner]) => owner !== repairingOwner))
      : owners;
    const violations = this.#deps.policy.check(
      change.role,
      change.changedFiles,
      visibleOwners,
      allowedPaths,
    );
    if (violations.length > 0) {
      throw new Error(
        `Ownership policy rejected ${change.role}:\n${violations
          .map((item) => `- ${item.path}: ${item.message}`)
          .join("\n")}`,
      );
    }
  }

  async #assertImmutableRun(state: VexRunState): Promise<void> {
    const currentHashes = hashRoleDefinitions(this.#deps.roles);
    if (!sameHashes(state.roleDefinitionHashes, currentHashes)) {
      throw new Error("Fixed role definitions changed after this run was planned");
    }
    if (state.manifest && !sameHashes(state.manifest.roleDefinitionHashes, currentHashes)) {
      throw new Error("Execution manifest role hashes no longer match the fixed roles");
    }
    if (state.workspaceKind === "directory") {
      if (!state.workspaceFingerprint) {
        throw new Error(`VEX ${state.id} has no directory snapshot fingerprint`);
      }
      await this.#deps.worktrees.assertDirectoryUnchanged(
        state.root,
        state.workspaceFingerprint,
      );
    } else {
      await this.#deps.worktrees.assertOriginalUnchanged(
        state.root,
        state.baseRef,
        state.baseBranch,
      );
    }
  }

  #integrationWorktree(state: VexRunState): WorktreeRecord {
    const integration = state.worktrees.find((item) => item.owner === "integrator");
    if (!integration) throw new Error(`VEX ${state.id} has no integration worktree`);
    return integration;
  }

  async #writeChange(state: VexRunState, change: ChangeResult): Promise<void> {
    await this.#deps.store.writeArtifact(
      state.root,
      state.id,
      `changes/${change.role}-${change.attempt}.json`,
      change,
    );
  }

  async #setPhase(
    state: VexRunState,
    phase: VexRunState["phase"],
    status: VexRunState["status"],
  ): Promise<void> {
    state.phase = phase;
    state.status = status;
    this.#event(state, "phase-changed", `Entered ${phase}`);
    await this.#save(state);
  }

  #event(
    state: VexRunState,
    type: string,
    message: string,
    role?: ModelRole,
  ): void {
    state.events.push({
      at: new Date().toISOString(),
      type,
      message,
      ...(role ? { role } : {}),
      phase: state.phase,
    });
  }

  async #save(state: VexRunState): Promise<void> {
    const previous = this.#saveQueues.get(state.id) ?? Promise.resolve();
    const next = previous.then(async () => {
      await this.#deps.store.save(state);
      await this.#deps.store.writeArtifact(
        state.root,
        state.id,
        "events.json",
        state.events,
      );
    });
    this.#saveQueues.set(state.id, next);
    try {
      await next;
    } finally {
      if (this.#saveQueues.get(state.id) === next) this.#saveQueues.delete(state.id);
    }
  }

  async #markFailed(
    state: VexRunState,
    error: unknown,
    signal?: AbortSignal,
  ): Promise<void> {
    const aborted =
      signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError");
    state.status = aborted ? "aborted" : "failed";
    delete state.activePid;
    state.error = error instanceof Error ? error.message : String(error);
    state.reviewsApproved = false;
    for (const role of MODEL_ROLES) {
      if (state.roles[role].status === "running") {
        state.roles[role] = {
          ...state.roles[role],
          status: aborted ? "aborted" : "failed",
          finishedAt: new Date().toISOString(),
        };
      }
    }
    this.#event(state, aborted ? "run-aborted" : "run-failed", state.error);
    await this.#save(state);
  }
}
