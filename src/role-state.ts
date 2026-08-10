import type { RoleState, RoleStatus } from "./types.js";

export type RoleLifecycleLabel =
  | "not-started"
  | "waiting"
  | "working"
  | "delivered"
  | "skipped"
  | "blocked"
  | "failed"
  | "aborted";

const labels: Record<RoleStatus, RoleLifecycleLabel> = {
  pending: "not-started",
  waiting: "waiting",
  running: "working",
  completed: "delivered",
  skipped: "skipped",
  blocked: "blocked",
  failed: "failed",
  aborted: "aborted",
};

const transitions: Record<RoleStatus, ReadonlySet<RoleStatus>> = {
  pending: new Set(["pending", "waiting", "running", "skipped", "failed", "aborted"]),
  waiting: new Set(["pending", "waiting", "running", "skipped", "blocked", "failed", "aborted"]),
  running: new Set(["waiting", "completed", "skipped", "blocked", "failed", "aborted"]),
  completed: new Set(["completed", "waiting", "running"]),
  skipped: new Set(["skipped", "waiting", "running"]),
  blocked: new Set(["pending", "waiting", "running", "blocked", "failed", "aborted"]),
  failed: new Set(["pending", "waiting", "running", "failed", "aborted"]),
  aborted: new Set(["pending", "waiting", "running", "failed", "aborted"]),
};

export interface RoleTransitionOptions {
  at?: string;
  attempts?: number;
  waitingFor?: string;
  summary?: string;
  error?: string;
}

export function roleStatusLabel(status: RoleStatus): RoleLifecycleLabel {
  return labels[status];
}

export function initialRoleState(at = new Date().toISOString()): RoleState {
  return { status: "pending", attempts: 0, statusChangedAt: at };
}

export function transitionRoleState(
  previous: RoleState,
  status: RoleStatus,
  options: RoleTransitionOptions = {},
): RoleState {
  if (!transitions[previous.status].has(status)) {
    throw new Error(`Invalid Agent state transition: ${previous.status} -> ${status}`);
  }
  const at = options.at ?? new Date().toISOString();
  const next: RoleState = {
    ...previous,
    status,
    attempts: options.attempts ?? previous.attempts,
    statusChangedAt: at,
  };
  delete next.waitingFor;
  delete next.error;

  if (status === "pending") {
    delete next.startedAt;
    delete next.finishedAt;
    delete next.summary;
  } else if (status === "waiting") {
    const waitingFor = options.waitingFor?.trim();
    if (!waitingFor) throw new Error("Waiting Agent state requires waitingFor");
    next.waitingFor = waitingFor;
    delete next.startedAt;
    delete next.finishedAt;
  } else if (status === "running") {
    next.startedAt = at;
    delete next.finishedAt;
  } else {
    next.finishedAt = at;
    if (options.summary !== undefined) next.summary = options.summary;
    if (options.error !== undefined) next.error = options.error;
  }
  return next;
}
