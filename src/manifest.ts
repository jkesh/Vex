import {
  MODEL_ROLES,
  type ExecutionManifest,
  type ModelRole,
  type RoleRunResult,
  type WriterRole,
} from "./types.js";

const WRITER_ROLES = ["backend", "frontend", "test-engineer"] as const;
const IMPLEMENTATION_ROLES = ["backend", "frontend"] as const;

export interface ManifestContext {
  runId?: string;
  repoRoot?: string;
  baseCommit?: string;
  projectCommands?: string[];
  constraints?: string[];
  riskFlags?: string[];
  roleDefinitionHashes?: Record<ModelRole, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringList(value: unknown, location: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`${location} must contain only strings`);
  }
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))];
}

function normalizeAllowedPath(value: string, role: WriterRole): string {
  const normalized = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    segments.includes("..") ||
    /(^|\/)\.(?:git|vex)(\/|$)/i.test(normalized)
  ) {
    throw new Error(`${role} has unsafe allowed path: ${value}`);
  }
  return normalized.replace(/\/$/, "");
}

function normalizeDependencies(value: unknown, role: WriterRole): WriterRole[] {
  if (!Array.isArray(value)) {
    return role === "test-engineer" ? [...IMPLEMENTATION_ROLES] : [];
  }
  const invalid = value.find(
    (item) =>
      typeof item !== "string" || !WRITER_ROLES.includes(item as WriterRole),
  );
  if (invalid !== undefined) {
    throw new Error(`${role} has an unknown dependency: ${String(invalid)}`);
  }
  const dependencies = [...new Set(value as WriterRole[])];
  if (dependencies.includes(role)) throw new Error(`${role} cannot depend on itself`);
  if (role !== "test-engineer" && dependencies.includes("test-engineer")) {
    throw new Error(`${role} cannot depend on test-engineer`);
  }
  return dependencies;
}

function validateDependencyGraph(
  assignments: ExecutionManifest["assignments"],
): void {
  const dependencies = new Map(
    assignments.map((assignment) => [assignment.role, assignment.dependencies]),
  );
  const visiting = new Set<WriterRole>();
  const visited = new Set<WriterRole>();
  const visit = (role: WriterRole) => {
    if (visited.has(role)) return;
    if (visiting.has(role)) {
      throw new Error(`Execution manifest contains a dependency cycle at ${role}`);
    }
    visiting.add(role);
    for (const dependency of dependencies.get(role) ?? []) visit(dependency);
    visiting.delete(role);
    visited.add(role);
  };
  for (const role of WRITER_ROLES) visit(role);
}

function ownershipPrefix(pattern: string): string {
  const wildcard = pattern.search(/[?*]/);
  return (wildcard < 0 ? pattern : pattern.slice(0, wildcard)).replace(/\/$/, "");
}

function ownershipPatternsOverlap(left: string, right: string): boolean {
  const leftPrefix = ownershipPrefix(left);
  const rightPrefix = ownershipPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return (
    leftPrefix === rightPrefix ||
    leftPrefix.startsWith(`${rightPrefix}/`) ||
    rightPrefix.startsWith(`${leftPrefix}/`)
  );
}

function validateOwnership(assignments: ExecutionManifest["assignments"]): void {
  for (let leftIndex = 0; leftIndex < assignments.length; leftIndex++) {
    const left = assignments[leftIndex]!;
    if (left.skipped) continue;
    for (const right of assignments.slice(leftIndex + 1)) {
      if (right.skipped) continue;
      for (const leftPath of left.allowedPaths) {
        const rightPath = right.allowedPaths.find((candidate) =>
          ownershipPatternsOverlap(leftPath, candidate),
        );
        if (rightPath) {
          throw new Error(
            `Execution manifest ownership overlaps: ${left.role}:${leftPath} and ${right.role}:${rightPath}`,
          );
        }
      }
    }
  }
}

export function validateExecutionManifest(manifest: ExecutionManifest): void {
  const roles = manifest.assignments.map((assignment) => assignment.role);
  for (const role of WRITER_ROLES) {
    if (roles.filter((candidate) => candidate === role).length !== 1) {
      throw new Error(`Execution manifest must contain exactly one ${role} assignment`);
    }
  }
  if (manifest.assignments.some((assignment) => !WRITER_ROLES.includes(assignment.role))) {
    throw new Error("Execution manifest contains an unknown writer role");
  }
  validateDependencyGraph(manifest.assignments);
  validateOwnership(manifest.assignments);
}

export function manifestFromArchitect(
  task: string,
  architect: RoleRunResult,
  context: ManifestContext = {},
): ExecutionManifest {
  const record = isRecord(architect.yield.payload) ? architect.yield.payload : {};
  const summary =
    typeof record.summary === "string" && record.summary.trim()
      ? record.summary.trim()
      : task;
  const rawAssignments = Array.isArray(record.assignments) ? record.assignments : [];
  for (const assignment of rawAssignments) {
    if (!isRecord(assignment)) {
      throw new Error("Execution manifest assignments must be objects");
    }
    if (!WRITER_ROLES.includes(assignment.role as WriterRole)) {
      throw new Error(
        `Execution manifest contains unknown role: ${String(assignment.role)}`,
      );
    }
  }

  const assignments = WRITER_ROLES.map((role) => {
    const candidates = rawAssignments.filter(
      (assignment): assignment is Record<string, unknown> =>
        isRecord(assignment) && assignment.role === role,
    );
    if (candidates.length > 1) {
      throw new Error(`Execution manifest contains duplicate ${role} assignments`);
    }
    const candidate = candidates[0];
    const objective =
      candidate && typeof candidate.objective === "string" && candidate.objective.trim()
        ? candidate.objective.trim()
        : `Determine whether ${role} work is needed for: ${summary}`;
    const rawPaths = candidate?.allowedPaths ?? candidate?.ownedPaths;
    const allowedPaths = stringList(rawPaths, `${role}.allowedPaths`).map((item) =>
      normalizeAllowedPath(item, role),
    );
    const skipped = candidate?.skipped === true || allowedPaths.length === 0;
    return {
      id:
        typeof candidate?.id === "string" && candidate.id.trim()
          ? candidate.id.trim()
          : `${context.runId ?? "run"}:${role}`,
      role,
      objective,
      allowedPaths,
      dependencies: normalizeDependencies(candidate?.dependencies, role),
      expectedResult:
        typeof candidate?.expectedResult === "string" &&
        candidate.expectedResult.trim()
          ? candidate.expectedResult.trim()
          : skipped
            ? "No repository changes"
            : `Committed ${role} changes within the allowed paths`,
      skipped,
    };
  });

  const orderInput = Array.isArray(record.integrationOrder)
    ? record.integrationOrder
    : [];
  const invalidOrderRole = orderInput.find(
    (item) =>
      typeof item !== "string" || !WRITER_ROLES.includes(item as WriterRole),
  );
  if (invalidOrderRole !== undefined) {
    throw new Error(
      `Execution manifest has unknown integration role: ${String(invalidOrderRole)}`,
    );
  }
  const integrationOrder = [
    ...new Set([...(orderInput as WriterRole[]), ...WRITER_ROLES]),
  ] as WriterRole[];
  const hashes = context.roleDefinitionHashes ??
    (Object.fromEntries(MODEL_ROLES.map((role) => [role, "unbound"])) as Record<
      ModelRole,
      string
    >);
  const manifest: ExecutionManifest = {
    runId: context.runId ?? "unbound",
    repoRoot: context.repoRoot ?? "",
    baseCommit: context.baseCommit ?? "",
    goal: task,
    summary,
    constraints: [
      ...new Set([
        ...(context.constraints ?? []),
        ...stringList(record.constraints, "manifest.constraints"),
      ]),
    ],
    contracts: stringList(record.contracts, "manifest.contracts"),
    assignments,
    integrationOrder,
    projectCommands: [...(context.projectCommands ?? [])],
    riskFlags: [
      ...new Set([
        ...(context.riskFlags ?? []),
        ...stringList(record.riskFlags, "manifest.riskFlags"),
      ]),
    ],
    roleDefinitionHashes: hashes,
    securityReview: record.securityReview === true,
  };
  validateExecutionManifest(manifest);
  return manifest;
}

export function readyImplementationRoles(
  manifest: ExecutionManifest,
  pending: ReadonlySet<WriterRole>,
  completed: ReadonlySet<WriterRole>,
): Array<"backend" | "frontend"> {
  return manifest.integrationOrder.filter(
    (role): role is "backend" | "frontend" => {
      if (!IMPLEMENTATION_ROLES.includes(role as "backend" | "frontend")) return false;
      if (!pending.has(role)) return false;
      const assignment = manifest.assignments.find((item) => item.role === role);
      return Boolean(
        assignment?.dependencies.every((dependency) => completed.has(dependency)),
      );
    },
  );
}
