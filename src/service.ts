import path from "node:path";
import { terminatePidTree } from "./command-runner.js";
import type { VexOrchestrator } from "./orchestrator.js";
import { createRunId } from "./orchestrator.js";
import type { RunStateStore } from "./state-store.js";
import type { VexRunOptions, VexRunState } from "./types.js";
import type { WorktreeManager } from "./worktrees.js";

export interface ActiveVexRun {
  id: string;
  promise: Promise<VexRunState>;
}

export class VexService {
  readonly #orchestrator: VexOrchestrator;
  readonly #store: RunStateStore;
  readonly #worktrees: WorktreeManager;
  #active:
    | { id: string; controller: AbortController; promise: Promise<VexRunState> }
    | undefined;

  constructor(
    orchestrator: VexOrchestrator,
    store: RunStateStore,
    worktrees: WorktreeManager,
  ) {
    this.#orchestrator = orchestrator;
    this.#store = store;
    this.#worktrees = worktrees;
  }

  plan(cwd: string, task: string, options: VexRunOptions = {}): ActiveVexRun {
    const id = createRunId();
    return this.#launch(id, (signal) =>
      this.#orchestrator.plan(cwd, task, id, options, signal),
    );
  }

  /** Starting a run means planning; writers still require explicit approval. */
  start(cwd: string, task: string, options: VexRunOptions = {}): ActiveVexRun {
    return this.plan(cwd, task, options);
  }

  async execute(cwd: string, runId?: string): Promise<ActiveVexRun> {
    const selected = await this.#select(cwd, runId);
    return this.#launch(selected.id, (signal) =>
      this.#orchestrator.execute(selected.root, selected.id, signal),
    );
  }

  async resume(cwd: string, runId?: string): Promise<ActiveVexRun> {
    const selected = await this.#select(cwd, runId);
    return this.#launch(selected.id, (signal) =>
      this.#orchestrator.resume(selected.root, selected.id, signal),
    );
  }

  async review(cwd: string, runId?: string): Promise<ActiveVexRun> {
    const selected = await this.#select(cwd, runId);
    return this.#launch(selected.id, (signal) =>
      this.#orchestrator.review(selected.root, selected.id, signal),
    );
  }

  async merge(cwd: string, runId?: string): Promise<VexRunState> {
    if (this.#active) throw new Error(`VEX run ${this.#active.id} is active`);
    const selected = await this.#select(cwd, runId);
    return this.#orchestrator.merge(selected.root, selected.id);
  }

  abort(): string | undefined {
    if (!this.#active) return undefined;
    this.#active.controller.abort();
    return this.#active.id;
  }

  async abortRun(cwd: string, runId?: string): Promise<string | undefined> {
    const activeId = this.abort();
    if (activeId) return activeId;
    const state = await this.#select(cwd, runId, false);
    if (!state || state.status === "completed" || state.status === "aborted") {
      return undefined;
    }
    state.status = "aborted";
    const activePid = state.activePid;
    state.error = activePid
      ? `Run abort requested for process ${activePid}`
      : "Run aborted by the user while no worker was active";
    delete state.activePid;
    state.reviewsApproved = false;
    for (const role of Object.values(state.roles)) {
      if (role.status === "running") role.status = "aborted";
    }
    state.events.push({
      at: new Date().toISOString(),
      type: "run-aborted",
      message: state.error,
      phase: state.phase,
    });
    await this.#store.save(state);
    await this.#store.writeArtifact(
      state.root,
      state.id,
      "events.json",
      state.events,
    );
    if (activePid && activePid !== process.pid) terminatePidTree(activePid);
    return state.id;
  }

  async status(cwd: string, runId?: string): Promise<VexRunState | undefined> {
    const root = await this.#root(cwd);
    return runId ? this.#store.load(root, runId) : this.#store.latest(root);
  }

  async diff(cwd: string, runId?: string): Promise<string> {
    const state = await this.#select(cwd, runId);
    const integrationRef = state.integrationRef ??
      state.worktrees.find((worktree) => worktree.owner === "integrator")?.branch;
    if (!integrationRef) throw new Error(`VEX ${state.id} has no integrated diff`);
    return this.#worktrees.diff(
      state.executionRoot,
      state.baseRef,
      integrationRef,
    );
  }

  async cleanup(cwd: string, runId?: string): Promise<number> {
    if (this.#active) throw new Error(`VEX run ${this.#active.id} is active`);
    const state = await this.#select(cwd, runId, false);
    if (!state) return 0;
    const originalCount = state.worktrees.length;
    const remaining = await this.#worktrees.removeMany(
      state.executionRoot,
      [...state.worktrees].reverse(),
    );
    const removed = originalCount - remaining.length;
    state.worktrees = remaining;
    await this.#store.save(state);
    if (remaining.length === 0 && state.workspaceKind === "directory") {
      await this.#worktrees.removeManagedRepository(state.executionRoot);
    }
    if (remaining.length > 0) {
      throw new Error(
        `Removed ${removed} VEX worktrees; ${remaining.length} could not be removed`,
      );
    }
    return removed;
  }

  #launch(
    id: string,
    operation: (signal: AbortSignal) => Promise<VexRunState>,
  ): ActiveVexRun {
    if (this.#active) throw new Error(`VEX run ${this.#active.id} is already active`);
    const controller = new AbortController();
    const promise = operation(controller.signal).finally(() => {
      if (this.#active?.id === id) this.#active = undefined;
    });
    this.#active = { id, controller, promise };
    return { id, promise };
  }

  async #root(cwd: string): Promise<string> {
    return path.resolve(await this.#worktrees.resolveWorkspaceRoot(cwd));
  }

  async #select(
    cwd: string,
    runId?: string,
    required?: true,
  ): Promise<VexRunState>;
  async #select(
    cwd: string,
    runId: string | undefined,
    required: false,
  ): Promise<VexRunState | undefined>;
  async #select(
    cwd: string,
    runId?: string,
    required = true,
  ): Promise<VexRunState | undefined> {
    const root = await this.#root(cwd);
    const state = runId
      ? await this.#store.load(root, runId)
      : await this.#store.latest(root);
    if (!state && required) throw new Error("No VEX runs found");
    return state;
  }
}

export function formatRunState(state: VexRunState): string {
  const roles = Object.entries(state.roles)
    .filter(([, role]) => role.status !== "pending")
    .map(([name, role]) => `${name}=${role.status}#${role.attempts}`)
    .join(", ");
  const ref = state.finalRef
    ? ` ref=${state.finalRef.slice(0, 12)}`
    : state.integrationRef
      ? ` integration=${state.integrationRef.slice(0, 12)}`
      : "";
  const findings = state.findings.length ? ` findings=${state.findings.length}` : "";
  const cleanup = state.worktrees.length > 0
    ? ` worktrees=${state.worktrees.length}`
    : "";
  const error = state.error ? ` error=${state.error}` : "";
  return `VEX ${state.id} status=${state.status} phase=${state.phase}${ref}${findings}${cleanup}${roles ? ` roles=[${roles}]` : ""}${error}`;
}

export function formatExecutionPlan(state: VexRunState): string {
  const manifest = state.manifest;
  if (!manifest) return formatRunState(state);
  const assignments = manifest.assignments
    .map((assignment) => {
      const runtime = state.roleRuntime[assignment.role];
      const dependencies = assignment.dependencies.length
        ? assignment.dependencies.join(",")
        : "none";
      const paths = assignment.allowedPaths.length
        ? assignment.allowedPaths.join(", ")
        : "none";
      return `${assignment.role}${assignment.skipped ? " [skip]" : ""}: ${assignment.objective}\n  route=${runtime.provider}/${runtime.model} thinking=${runtime.thinking}\n  paths=${paths}; depends=${dependencies}`;
    })
    .join("\n");
  const commands = manifest.projectCommands.length
    ? manifest.projectCommands.join("\n  ")
    : "none";
  return `VEX ${state.id}\nGoal: ${manifest.goal}\nBase: ${state.baseBranch}@${state.baseRef.slice(0, 12)}\nIntegration branch: vex/${state.id.toLowerCase()}/integrator\nAssignments:\n${assignments}\nProject commands:\n  ${commands}\nSecurity review: ${state.securityReview ? "yes" : "no"}\n\nNo writer has started. Confirm to execute; merging remains a separate /team-merge action.`;
}
