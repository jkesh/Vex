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
export type ThinkingLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type ProviderProtocol =
  | "openai-chat-completions"
  | "anthropic-messages";
export type ModelCatalogProtocol = "openai" | "anthropic";

export type RoleStage =
  | "discovery"
  | "design"
  | "implementation"
  | "verification"
  | "review";
export type RoleStatus =
  | "pending"
  | "waiting"
  | "running"
  | "completed"
  | "skipped"
  | "blocked"
  | "failed"
  | "aborted";
export type RunStatus =
  | "created"
  | "planning"
  | "awaiting-confirmation"
  | "running"
  | "awaiting-merge"
  | "completed"
  | "failed"
  | "aborted";
export type RunPhase =
  | "preflight"
  | "discovery"
  | "design"
  | "approval"
  | "implementation"
  | "integration"
  | "verification"
  | "review"
  | "repair"
  | "ready-to-merge"
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

export interface RoleRuntimeConfig {
  provider: string;
  model: string;
  thinking: ThinkingLevel;
  source: "agent" | "default" | "environment" | "session";
}

export interface ProviderRuntimeConfig {
  id: string;
  protocol: ProviderProtocol;
  modelCatalog: ModelCatalogProtocol;
  baseUrl: string;
  apiKeyEnv?: string;
  requiresAuth: boolean;
  headersEnv: Record<string, string>;
  sendReasoningEffort: boolean;
  timeoutMs: number;
  maxAgentTurns: number;
}

export interface ProviderTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface TokenUsage extends ProviderTokenUsage {
  requests: number;
  reportedRequests: number;
}

export interface AgentTokenUsage extends TokenUsage {
  provider: string;
  model: string;
}

export interface ModelTokenUsage extends TokenUsage {
  provider: string;
  model: string;
}

export interface ProviderUsage extends TokenUsage {
  provider: string;
}

export interface RunTokenUsage {
  total: TokenUsage;
  agents: Record<ModelRole, AgentTokenUsage>;
  providers: ProviderUsage[];
  models: ModelTokenUsage[];
}

export interface ResolvedVexConfig {
  maxParallelWriters: 1 | 2;
  maxRepairAttempts: number;
  projectCommands: string[];
  defaultProvider: string;
  provider: ProviderRuntimeConfig;
  providers: Record<string, ProviderRuntimeConfig>;
  agents: Record<ModelRole, RoleRuntimeConfig>;
  sources: string[];
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
  id: string;
  role: WriterRole;
  objective: string;
  allowedPaths: string[];
  dependencies: WriterRole[];
  expectedResult: string;
  skipped: boolean;
}

export interface ExecutionManifest {
  runId: string;
  repoRoot: string;
  baseCommit: string;
  goal: string;
  summary: string;
  constraints: string[];
  contracts: string[];
  assignments: RoleAssignment[];
  integrationOrder: WriterRole[];
  projectCommands: string[];
  riskFlags: string[];
  roleDefinitionHashes: Record<ModelRole, string>;
  securityReview: boolean;
}

export interface CommandResult {
  command: string;
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  startedAt: string;
  finishedAt: string;
}

export interface ChangeResult {
  assignmentId: string;
  role: WriterRole;
  attempt: number;
  status: RoleYield["status"];
  summary: string;
  commits: string[];
  changedFiles: string[];
  commandResults: CommandResult[];
  notes: string[];
  worktreePath: string;
}

export type ReviewPriority = 0 | 1 | 2 | 3;

export interface ReviewFinding {
  owner: WriterRole;
  priority: ReviewPriority;
  file?: string;
  line?: number;
  title: string;
  explanation: string;
  source: "reviewer" | "security-reviewer";
}

export interface ReviewReport {
  approved: boolean;
  findings: ReviewFinding[];
  summary: string;
}

export interface ReviewCycle {
  attempt: number;
  reports: Partial<Record<"reviewer" | "security-reviewer", ReviewReport>>;
  findings: ReviewFinding[];
  approved: boolean;
  createdAt: string;
}

export interface RoleRunInput {
  runId: string;
  role: RoleDefinition;
  task: string;
  cwd: string;
  context: Record<string, unknown>;
  knowledge: KnowledgeDocument[];
  runtime: RoleRuntimeConfig;
  provider: ProviderRuntimeConfig;
  resumeSession?: boolean;
}

export interface RoleRunResult {
  role: ModelRole;
  exitCode: number;
  yield: RoleYield;
  stderr: string;
  rawOutput: string;
  usage: AgentTokenUsage;
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
  attempts: number;
  statusChangedAt: string;
  waitingFor?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
  error?: string;
}

export interface RunEvent {
  at: string;
  type: string;
  message: string;
  role?: ModelRole;
  phase?: RunPhase;
}

export interface VexRunState {
  schemaVersion: 7;
  id: string;
  task: string;
  root: string;
  executionRoot: string;
  workspaceKind: "git" | "directory";
  workspaceFingerprint?: string;
  baseBranch: string;
  baseRef: string;
  status: RunStatus;
  phase: RunPhase;
  securityReview: boolean;
  projectTrusted: boolean;
  defaultProvider: string;
  provider: ProviderRuntimeConfig;
  providers: Record<string, ProviderRuntimeConfig>;
  maxParallelWriters: 1 | 2;
  maxRepairAttempts: number;
  configuredProjectCommands: string[];
  configurationSources: string[];
  roleRuntime: Record<ModelRole, RoleRuntimeConfig>;
  roleDefinitionHashes: Record<ModelRole, string>;
  createdAt: string;
  updatedAt: string;
  activePid?: number;
  approvedAt?: string;
  roles: Record<ModelRole, RoleState>;
  usage: RunTokenUsage;
  scoutReport?: ScoutReport;
  manifest?: ExecutionManifest;
  worktrees: WorktreeRecord[];
  changes: ChangeResult[];
  commandResults: CommandResult[];
  reviewCycles: ReviewCycle[];
  findings: ReviewFinding[];
  events: RunEvent[];
  integratedCommits: string[];
  integrationRef?: string;
  finalRef?: string;
  reviewsApproved: boolean;
  error?: string;
}

export interface VexRunOptions {
  securityReview?: boolean;
  model?: string;
  provider?: string;
  roleRoutes?: Partial<
    Record<ModelRole, { provider?: string; model?: string }>
  >;
  projectTrusted?: boolean;
}
