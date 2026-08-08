import type { RoleKnowledgeClient } from "./knowledge.js";
import { FileOwnershipPolicy } from "./policy.js";
import type { RunStateStore } from "./state-store.js";
import {
  MODEL_ROLES,
  type ChangeResult,
  type ExecutionManifest,
  type ModelRole,
  type RoleDefinition,
  type RoleRunResult,
  type RoleState,
  type ReviewReport,
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
}

function initialRoleStates(): Record<ModelRole, RoleState> {
  return Object.fromEntries(
    MODEL_ROLES.map((role) => [role, { status: "pending" }]),
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

function reviewApproved(result: RoleRunResult): boolean {
  if (!resultSucceeded(result) || result.yield.status === "skipped")
    return false;
  const payload = result.yield.payload as Partial<ReviewReport> | undefined;
  return payload?.approved === true;
}

function defaultManifest(
  task: string,
  architect: RoleRunResult,
): ExecutionManifest {
  const payload = architect.yield.payload;
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const objective =
    typeof record.summary === "string" && record.summary
      ? record.summary
      : task;
  const rawAssignments = Array.isArray(record.assignments)
    ? record.assignments
    : [];
  const assignments: ExecutionManifest["assignments"] = (
    ["backend", "frontend", "test-engineer"] as const
  ).map((role) => {
    const candidate = rawAssignments.find(
      (assignment): assignment is Record<string, unknown> =>
        assignment !== null &&
        typeof assignment === "object" &&
        (assignment as Record<string, unknown>).role === role,
    );
    return {
      role,
      objective:
        candidate && typeof candidate.objective === "string"
          ? candidate.objective
          : `Determine whether ${role} work is needed for: ${objective}`,
      ownedPaths:
        candidate && Array.isArray(candidate.ownedPaths)
          ? candidate.ownedPaths.filter(
              (item): item is string => typeof item === "string",
            )
          : [],
      dependencies: role === "test-engineer" ? ["backend", "frontend"] : [],
    };
  });
  return {
    summary: objective,
    assignments,
    integrationOrder: ["backend", "frontend", "test-engineer"],
    securityReview: record.securityReview === true,
  };
}

export class VexOrchestrator {
  readonly #deps: VexOrchestratorDependencies;

  constructor(dependencies: VexOrchestratorDependencies) {
    this.#deps = dependencies;
  }

  async run(
    rootCandidate: string,
    task: string,
    runId: string,
    options: VexRunOptions = {},
    signal?: AbortSignal,
  ) {
    const repository =
      await this.#deps.worktrees.inspectRepository(rootCandidate);
    const now = new Date().toISOString();
    const state: VexRunState = {
      schemaVersion: 1,
      id: runId,
      task,
      root: repository.root,
      baseBranch: repository.branch,
      baseRef: repository.head,
      status: "created",
      phase: "preflight",
      securityReview: options.securityReview ?? false,
      createdAt: now,
      updatedAt: now,
      roles: initialRoleStates(),
      worktrees: [],
      changes: [],
      integratedCommits: [],
    };
    const runDirectory = await this.#deps.store.runDirectory(
      repository.root,
      runId,
    );

    let saveQueue = Promise.resolve();
    const persist = async () => {
      saveQueue = saveQueue.then(() => this.#deps.store.save(state));
      await saveQueue;
    };
    const setPhase = async (phase: VexRunState["phase"]) => {
      state.phase = phase;
      state.status = "running";
      await persist();
    };
    const runRole = async (
      name: ModelRole,
      cwd: string,
      context: Record<string, unknown>,
    ): Promise<RoleRunResult> => {
      if (signal?.aborted)
        throw new DOMException("VEX run aborted", "AbortError");
      const startedAt = new Date().toISOString();
      state.roles[name] = { status: "running", startedAt };
      await persist();
      const knowledge = await this.#deps.knowledge.retrieve({
        role: name,
        query: task,
        cwd,
        runId,
        ...(signal ? { signal } : {}),
      });
      const result = await this.#deps.runner.run(
        {
          runId,
          role: requireRole(this.#deps.roles, name),
          task,
          cwd,
          context: {
            repositoryRoot: repository.root,
            runDirectory,
            ...context,
          },
          knowledge,
        },
        signal,
      );
      state.roles[name] = {
        status: resultSucceeded(result) ? result.yield.status : "failed",
        startedAt,
        finishedAt: new Date().toISOString(),
        summary: result.yield.summary,
        ...(resultSucceeded(result)
          ? {}
          : { error: result.stderr || result.yield.summary }),
      };
      await persist();
      if (!resultSucceeded(result))
        throw new Error(`${name} failed: ${result.yield.summary}`);
      return result;
    };

    await persist();
    try {
      await setPhase("discovery");
      const scout = await runRole("scout", repository.root, {
        baseRef: repository.head,
      });

      await setPhase("design");
      const architect = await runRole("architect", repository.root, {
        scout: scout.yield.payload ?? scout.yield.summary,
      });
      const manifest = defaultManifest(task, architect);
      state.securityReview = state.securityReview || manifest.securityReview;

      await setPhase("implementation");
      const integration = await this.#deps.worktrees.create(
        repository.root,
        runId,
        "integrator",
        repository.head,
      );
      state.worktrees.push(integration);
      const writerWorktrees = new Map<WriterRole, WorktreeRecord>();
      for (const role of ["backend", "frontend"] as const) {
        const worktree = await this.#deps.worktrees.create(
          repository.root,
          runId,
          role,
          repository.head,
        );
        writerWorktrees.set(role, worktree);
        state.worktrees.push(worktree);
      }
      await persist();

      const implementationResults = await Promise.all(
        (["backend", "frontend"] as const).map(async (role) => {
          const worktree = writerWorktrees.get(role)!;
          const assignment = manifest.assignments.find(
            (item) => item.role === role,
          );
          const result = await runRole(role, worktree.path, {
            manifest,
            assignment,
            scout: scout.yield.payload,
          });
          return this.#collectChange(role, worktree, result);
        }),
      );

      const fileOwners = new Map<string, WriterRole>();
      for (const change of implementationResults) {
        this.#enforcePolicy(change, fileOwners);
        change.changedFiles.forEach((file) =>
          fileOwners.set(file, change.role),
        );
        state.changes.push(change);
      }
      await persist();

      await setPhase("integration");
      for (const role of ["backend", "frontend"] as const) {
        const change = implementationResults.find(
          (item) => item.role === role,
        )!;
        await this.#deps.worktrees.integrate(integration, change.commits);
        state.integratedCommits.push(...change.commits);
      }
      await persist();

      await setPhase("verification");
      const integratedHead = await this.#deps.worktrees.head(integration);
      const testWorktree = await this.#deps.worktrees.create(
        repository.root,
        runId,
        "test-engineer",
        integratedHead,
      );
      state.worktrees.push(testWorktree);
      await persist();
      const testResult = await runRole("test-engineer", testWorktree.path, {
        manifest,
        changes: implementationResults,
      });
      const testChange = await this.#collectChange(
        "test-engineer",
        testWorktree,
        testResult,
      );
      this.#enforcePolicy(testChange, fileOwners);
      state.changes.push(testChange);
      await this.#deps.worktrees.integrate(integration, testChange.commits);
      state.integratedCommits.push(...testChange.commits);
      await persist();

      await setPhase("review");
      const reviewer = await runRole("reviewer", integration.path, {
        manifest,
        changes: state.changes,
      });
      if (!reviewApproved(reviewer))
        throw new Error(
          `reviewer rejected the integrated result: ${reviewer.yield.summary}`,
        );
      if (state.securityReview) {
        const security = await runRole("security-reviewer", integration.path, {
          manifest,
          changes: state.changes,
        });
        if (!reviewApproved(security)) {
          throw new Error(
            `security-reviewer rejected the integrated result: ${security.yield.summary}`,
          );
        }
      } else {
        state.roles["security-reviewer"] = {
          status: "skipped",
          summary: "Security review was not requested",
        };
      }

      await setPhase("finalize");
      state.finalRef = await this.#deps.worktrees.finalize(
        repository.root,
        repository.head,
        integration,
      );
      const pendingCleanup: WorktreeRecord[] = [];
      for (const worktree of [...state.worktrees].reverse()) {
        try {
          await this.#deps.worktrees.remove(repository.root, worktree);
        } catch {
          pendingCleanup.push(worktree);
        }
      }
      state.worktrees = pendingCleanup.reverse();
      state.phase = "done";
      state.status = "completed";
      await persist();
      return state;
    } catch (error) {
      const aborted =
        signal?.aborted ||
        (error instanceof DOMException && error.name === "AbortError");
      state.status = aborted ? "aborted" : "failed";
      state.error = error instanceof Error ? error.message : String(error);
      for (const role of MODEL_ROLES) {
        if (state.roles[role].status === "running")
          state.roles[role].status = aborted ? "aborted" : "failed";
      }
      await persist();
      throw error;
    }
  }

  async #collectChange(
    role: WriterRole,
    worktree: WorktreeRecord,
    result: RoleRunResult,
  ): Promise<ChangeResult> {
    const dirty = await this.#deps.worktrees.status(worktree);
    if (dirty) throw new Error(`${role} left uncommitted changes:\n${dirty}`);
    const commits = await this.#deps.worktrees.commitsSince(worktree);
    const changedFiles = await this.#deps.worktrees.changedFiles(worktree);
    if (
      result.yield.status === "completed" &&
      commits.length === 0 &&
      changedFiles.length === 0
    ) {
      result.yield.status = "skipped";
    }
    return {
      role,
      status: result.yield.status,
      summary: result.yield.summary,
      commits,
      changedFiles,
      worktreePath: worktree.path,
    };
  }

  #enforcePolicy(
    change: ChangeResult,
    owners: ReadonlyMap<string, WriterRole>,
  ): void {
    const violations = this.#deps.policy.check(
      change.role,
      change.changedFiles,
      owners,
    );
    if (violations.length > 0) {
      throw new Error(
        `Ownership policy rejected ${change.role}:\n${violations.map((item) => `- ${item.path}: ${item.message}`).join("\n")}`,
      );
    }
  }
}
