export const MODEL_ROLES = [
  "scout",
  "architect",
  "backend",
  "frontend",
  "test-engineer",
  "reviewer",
  "security-reviewer",
] as const;

export type ModelRole = (typeof MODEL_ROLES)[number];
export type WriterRole = Extract<
  ModelRole,
  "backend" | "frontend" | "test-engineer"
>;
export type WorktreeOwner = WriterRole | "integrator";

export type RoleStage =
  | "discovery"
  | "design"
  | "implementation"
  | "verification"
  | "review";
export type RoleStatus =
  | "pending"
  | "running"
  | "completed"
  | "skipped"
  | "blocked"
  | "failed"
  | "aborted";
export type RunStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "aborted";
export type RunPhase =
  | "preflight"
  | "discovery"
  | "design"
  | "implementation"
  | "integration"
  | "verification"
  | "review"
  | "finalize"
  | "done";

export interface RoleDefinition {
  name: ModelRole;
  description: string;
  stage: RoleStage;
  tools: string[];
  writes: boolean;
  spawns: string[];
  systemPrompt: string;
  filePath: string;
}

export interface KnowledgeDocument {
  id: string;
  content: string;
  source?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface RoleYield {
  role: ModelRole;
  status: Extract<RoleStatus, "completed" | "skipped" | "blocked" | "failed">;
  summary: string;
  artifacts: string[];
  payload?: unknown;
}

export interface ScoutReport {
  repositorySummary: string;
  relevantPaths: string[];
  constraints: string[];
  risks: string[];
}

export interface RoleAssignment {
  role: WriterRole;
  objective: string;
  ownedPaths: string[];
  dependencies: WriterRole[];
}

export interface ExecutionManifest {
  summary: string;
  assignments: RoleAssignment[];
  integrationOrder: WriterRole[];
  securityReview: boolean;
}

export interface ChangeResult {
  role: WriterRole;
  status: RoleYield["status"];
  summary: string;
  commits: string[];
  changedFiles: string[];
  worktreePath: string;
}

export interface ReviewFinding {
  severity: "critical" | "high" | "medium" | "low";
  path?: string;
  line?: number;
  message: string;
}

export interface ReviewReport {
  approved: boolean;
  findings: ReviewFinding[];
  summary: string;
}

export interface RoleRunInput {
  runId: string;
  role: RoleDefinition;
  task: string;
  cwd: string;
  context: Record<string, unknown>;
  knowledge: KnowledgeDocument[];
}

export interface RoleRunResult {
  role: ModelRole;
  exitCode: number;
  yield: RoleYield;
  stderr: string;
  rawOutput: string;
}

export interface RoleRunner {
  run(input: RoleRunInput, signal?: AbortSignal): Promise<RoleRunResult>;
}

export interface WorktreeRecord {
  owner: WorktreeOwner;
  path: string;
  branch: string;
  baseRef: string;
}

export interface RoleState {
  status: RoleStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
}

export interface VexRunState {
  schemaVersion: 1;
  id: string;
  task: string;
  root: string;
  baseBranch: string;
  baseRef: string;
  status: RunStatus;
  phase: RunPhase;
  securityReview: boolean;
  createdAt: string;
  updatedAt: string;
  roles: Record<ModelRole, RoleState>;
  worktrees: WorktreeRecord[];
  changes: ChangeResult[];
  integratedCommits: string[];
  finalRef?: string;
  error?: string;
}

export interface VexRunOptions {
  securityReview?: boolean;
}
