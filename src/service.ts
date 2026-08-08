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

  start(cwd: string, task: string, options: VexRunOptions = {}): ActiveVexRun {
    if (this.#active)
      throw new Error(`VEX run ${this.#active.id} is already active`);
    const id = createRunId();
    const controller = new AbortController();
    const promise = this.#orchestrator
      .run(cwd, task, id, options, controller.signal)
      .finally(() => {
        if (this.#active?.id === id) this.#active = undefined;
      });
    this.#active = { id, controller, promise };
    return { id, promise };
  }

  abort(): string | undefined {
    if (!this.#active) return undefined;
    this.#active.controller.abort();
    return this.#active.id;
  }

  async status(cwd: string): Promise<VexRunState | undefined> {
    const root = await this.#worktrees.git.output(cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    return this.#store.latest(root);
  }

  async cleanup(cwd: string): Promise<number> {
    if (this.#active) throw new Error(`VEX run ${this.#active.id} is active`);
    const root = await this.#worktrees.git.output(cwd, [
      "rev-parse",
      "--show-toplevel",
    ]);
    const state = await this.#store.latest(root);
    if (!state) return 0;
    let removed = 0;
    for (const worktree of [...state.worktrees].reverse()) {
      await this.#worktrees.remove(root, worktree);
      removed++;
    }
    if (removed > 0) {
      state.worktrees = [];
      await this.#store.save(state);
    }
    return removed;
  }
}

export function formatRunState(state: VexRunState): string {
  const roles = Object.entries(state.roles)
    .filter(([, role]) => role.status !== "pending")
    .map(([name, role]) => `${name}=${role.status}`)
    .join(", ");
  const ref = state.finalRef ? ` ref=${state.finalRef.slice(0, 12)}` : "";
  const cleanup =
    state.worktrees.length > 0
      ? ` cleanupPending=${state.worktrees.length}`
      : "";
  const error = state.error ? ` error=${state.error}` : "";
  return `VEX ${state.id} status=${state.status} phase=${state.phase}${ref}${cleanup}${roles ? ` roles=[${roles}]` : ""}${error}`;
}
