import { createHash } from "node:crypto";
import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GitClient } from "./git.js";
import type { WorktreeOwner, WorktreeRecord } from "./types.js";

export interface RepositorySnapshot {
  root: string;
  executionRoot: string;
  kind: "git" | "directory";
  branch: string;
  head: string;
  fingerprint?: string;
}

export interface WorkspaceSnapshot {
  root: string;
  kind: "git" | "directory";
  branch: string;
  head: string;
  dirty: boolean;
}

const EXCLUDED_DIRECTORIES = new Set([
  ".git",
  ".vex",
  ".vex-worktrees",
  "node_modules",
]);

const GENERATED_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".pnpm-store",
  ".vite",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
]);

function normalizedRelative(root: string, candidate: string): string {
  return path.relative(root, candidate).replaceAll("\\", "/");
}

function excludedWorkspacePath(root: string, candidate: string): boolean {
  const relative = normalizedRelative(root, candidate);
  if (!relative) return false;
  const parts = relative.split("/");
  if (parts.some((part) => EXCLUDED_DIRECTORIES.has(part))) return true;
  const name = parts.at(-1) ?? "";
  return (
    /^\.env(?:\.|$)/i.test(name) ||
    /\.(?:pem|key|p12|pfx)$/i.test(name)
  );
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

async function fingerprintDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (excludedWorkspacePath(root, candidate)) continue;
      const relative = normalizedRelative(root, candidate);
      if (entry.isDirectory()) {
        hash.update(`D\0${relative}\0`);
        await visit(candidate);
      } else if (entry.isSymbolicLink()) {
        hash.update(`L\0${relative}\0${await readlink(candidate)}\0`);
      } else if (entry.isFile()) {
        hash.update(`F\0${relative}\0`);
        hash.update(await readFile(candidate));
        hash.update("\0");
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

function assertSafeRelativeFile(root: string, relativePath: string): string {
  const normalized = relativePath.replaceAll("\\", "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:\//i.test(normalized) ||
    normalized.split("/").some((part) => !part || part === "..") ||
    excludedWorkspacePath(root, path.join(root, normalized))
  ) {
    throw new Error(`Unsafe managed workspace path: ${relativePath}`);
  }
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Managed workspace path escapes its root: ${relativePath}`);
  }
  return target;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export class WorktreeManager {
  constructor(
    readonly git = new GitClient(),
    readonly worktreeBase?: string,
    readonly managedBase = path.join(os.homedir(), ".vex", "workspaces"),
  ) {}

  async resolveWorkspaceRoot(cwd: string): Promise<string> {
    const result = await this.git.run(
      cwd,
      ["rev-parse", "--show-toplevel"],
      true,
    );
    const root = result.stdout.trim();
    return result.exitCode === 0 && root ? path.resolve(root) : path.resolve(cwd);
  }

  async inspectWorkspace(cwd: string): Promise<WorkspaceSnapshot> {
    const rootResult = await this.git.run(
      cwd,
      ["rev-parse", "--show-toplevel"],
      true,
    );
    const discoveredRoot = rootResult.stdout.trim();
    if (rootResult.exitCode !== 0 || !discoveredRoot) {
      return {
        root: path.resolve(cwd),
        kind: "directory",
        branch: "",
        head: "",
        dirty: false,
      };
    }

    const root = path.resolve(discoveredRoot);
    const [branchResult, headResult, statusResult] = await Promise.all([
      this.git.run(
        root,
        ["symbolic-ref", "--quiet", "--short", "HEAD"],
        true,
      ),
      this.git.run(root, ["rev-parse", "HEAD"], true),
      this.git.run(
        root,
        ["status", "--porcelain", "--untracked-files=normal"],
        true,
      ),
    ]);
    return {
      root,
      kind: "git",
      branch: branchResult.stdout.trim() || "detached",
      head: headResult.exitCode === 0 ? headResult.stdout.trim() : "",
      dirty: Boolean(statusResult.stdout.trim()),
    };
  }

  async prepareRepository(
    cwd: string,
    runId: string,
  ): Promise<RepositorySnapshot> {
    const workspace = await this.inspectWorkspace(cwd);
    if (workspace.kind === "git") {
      if (!workspace.head) {
        throw new Error(
          "The Git workspace needs a baseline commit before isolated execution.",
        );
      }
      if (workspace.dirty) {
        throw new Error("VEX requires a clean working tree before agent execution");
      }
      return {
        root: workspace.root,
        executionRoot: workspace.root,
        kind: "git",
        branch: workspace.branch,
        head: workspace.head,
      };
    }

    const sourceRoot = workspace.root;
    const fingerprint = await fingerprintDirectory(sourceRoot);
    const workspaceId = createHash("sha256")
      .update(sourceRoot.toLowerCase())
      .digest("hex")
      .slice(0, 16);
    const managedRunRoot = path.join(
      this.managedBase,
      workspaceId,
      slug(runId),
    );
    const repositoryRoot = path.join(managedRunRoot, "repository");
    if (await exists(managedRunRoot)) {
      throw new Error(`Managed VEX workspace already exists: ${managedRunRoot}`);
    }

    await mkdir(managedRunRoot, { recursive: true });
    try {
      await cp(sourceRoot, repositoryRoot, {
        recursive: true,
        filter: (source) => !excludedWorkspacePath(sourceRoot, source),
      });
      await this.git.run(repositoryRoot, ["init", "-b", "main"]);
      await this.git.run(repositoryRoot, ["config", "user.name", "VEX"]);
      await this.git.run(repositoryRoot, [
        "config",
        "user.email",
        "vex@localhost",
      ]);
      await this.git.run(repositoryRoot, ["add", "-A"]);
      await this.git.run(repositoryRoot, [
        "commit",
        "--allow-empty",
        "-m",
        "VEX managed workspace baseline",
      ]);
      const head = await this.git.output(repositoryRoot, ["rev-parse", "HEAD"]);
      return {
        root: sourceRoot,
        executionRoot: repositoryRoot,
        kind: "directory",
        branch: "workspace",
        head,
        fingerprint,
      };
    } catch (error) {
      await rm(managedRunRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async create(
    root: string,
    runId: string,
    owner: WorktreeOwner,
    baseRef: string,
  ): Promise<WorktreeRecord> {
    const branch = `vex/${slug(runId)}/${owner}`;
    const base =
      this.worktreeBase ??
      path.join(path.dirname(root), ".vex-worktrees", path.basename(root));
    const worktreePath = path.join(base, slug(runId), owner);
    await mkdir(path.dirname(worktreePath), { recursive: true });
    await this.git.run(root, [
      "worktree",
      "add",
      "-b",
      branch,
      worktreePath,
      baseRef,
    ]);
    return { owner, path: worktreePath, branch, baseRef };
  }

  async head(worktree: WorktreeRecord): Promise<string> {
    return this.git.output(worktree.path, ["rev-parse", "HEAD"]);
  }

  async commitsSince(worktree: WorktreeRecord): Promise<string[]> {
    return this.commitsBetween(worktree, worktree.baseRef);
  }

  async commitsBetween(
    worktree: WorktreeRecord,
    baseRef: string,
  ): Promise<string[]> {
    const output = await this.git.output(worktree.path, [
      "rev-list",
      "--reverse",
      `${baseRef}..HEAD`,
    ]);
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  }

  async changedFiles(worktree: WorktreeRecord): Promise<string[]> {
    return this.changedFilesBetween(worktree, worktree.baseRef);
  }

  async changedFilesBetween(
    worktree: WorktreeRecord,
    baseRef: string,
  ): Promise<string[]> {
    const output = await this.git.output(worktree.path, [
      "diff",
      "--name-only",
      "--diff-filter=ACMRD",
      `${baseRef}..HEAD`,
    ]);
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  }

  async status(worktree: WorktreeRecord): Promise<string> {
    return this.git.output(worktree.path, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
  }

  async synchronize(
    worktree: WorktreeRecord,
    baseRef: string,
  ): Promise<void> {
    const dirty = await this.status(worktree);
    if (dirty) {
      throw new Error(
        `Cannot synchronize dirty VEX worktree ${worktree.owner}:\n${dirty}`,
      );
    }
    await this.git.run(worktree.path, ["reset", "--hard", baseRef]);
    await this.git.run(worktree.path, ["clean", "-fdx"]);
    worktree.baseRef = baseRef;
  }

  async checkpoint(worktree: WorktreeRecord, message: string): Promise<string> {
    await this.pruneUntrackedGeneratedDirectories(worktree);
    await this.git.run(worktree.path, ["add", "-A"]);
    await this.git.run(worktree.path, [
      "-c",
      "user.name=VEX",
      "-c",
      "user.email=vex@localhost",
      "commit",
      "-m",
      message,
    ]);
    return this.head(worktree);
  }

  async pruneUntrackedGeneratedDirectories(
    worktree: WorktreeRecord,
  ): Promise<string[]> {
    const root = path.resolve(worktree.path);
    const removed: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === ".git") {
          continue;
        }
        const candidate = path.resolve(directory, entry.name);
        const relative = path.relative(root, candidate);
        if (
          !relative ||
          relative.startsWith("..") ||
          path.isAbsolute(relative)
        ) {
          throw new Error(`Generated directory escapes VEX worktree: ${candidate}`);
        }
        const normalized = relative.replaceAll("\\", "/");
        if (GENERATED_DIRECTORY_NAMES.has(entry.name)) {
          const tracked = await this.git.output(root, [
            "ls-files",
            "--",
            normalized,
          ]);
          if (!tracked) {
            await rm(candidate, {
              recursive: true,
              force: true,
              maxRetries: 3,
              retryDelay: 100,
            });
            removed.push(normalized);
            continue;
          }
        }
        await visit(candidate);
      }
    };
    await visit(root);
    return removed;
  }

  async integrate(target: WorktreeRecord, commits: string[]): Promise<void> {
    for (const commit of commits) {
      const result = await this.git.run(
        target.path,
        ["cherry-pick", commit],
        true,
      );
      if (result.exitCode === 0) continue;
      await this.git.run(target.path, ["cherry-pick", "--abort"], true);
      throw new Error(
        `Integration conflict for ${commit}: ${result.stderr.trim() || result.stdout.trim()}`,
      );
    }
  }

  async assertOriginalUnchanged(
    root: string,
    expectedBase: string,
    expectedBranch?: string,
  ): Promise<void> {
    const current = await this.git.output(root, ["rev-parse", "HEAD"]);
    if (current !== expectedBase)
      throw new Error(`Main worktree moved from ${expectedBase} to ${current}`);
    const status = await this.git.output(root, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
    if (status)
      throw new Error(`Main worktree changed during the VEX run:\n${status}`);
    if (expectedBranch) {
      const branch = await this.git.output(root, [
        "symbolic-ref",
        "--quiet",
        "--short",
        "HEAD",
      ]);
      if (branch !== expectedBranch) {
        throw new Error(
          `Main worktree switched from ${expectedBranch} to ${branch}`,
        );
      }
    }
  }

  async assertDirectoryUnchanged(
    root: string,
    expectedFingerprint: string,
  ): Promise<void> {
    const current = await fingerprintDirectory(path.resolve(root));
    if (current !== expectedFingerprint) {
      throw new Error(
        "The workspace changed after VEX created its managed snapshot. Review those changes before continuing.",
      );
    }
  }

  async mergeIntoOriginal(
    root: string,
    expectedBase: string,
    expectedBranch: string,
    integration: WorktreeRecord,
  ): Promise<string> {
    await this.assertOriginalUnchanged(root, expectedBase, expectedBranch);
    await this.git.run(root, ["merge", "--ff-only", integration.branch]);
    return this.git.output(root, ["rev-parse", "HEAD"]);
  }

  async mergeIntoDirectory(
    root: string,
    expectedFingerprint: string,
    integration: WorktreeRecord,
    backupRoot: string,
  ): Promise<string> {
    const resolvedRoot = path.resolve(root);
    await this.assertDirectoryUnchanged(resolvedRoot, expectedFingerprint);
    const output = await this.git.output(integration.path, [
      "diff",
      "--name-only",
      "--diff-filter=ACMRD",
      "-z",
      `${integration.baseRef}..HEAD`,
    ]);
    const changedFiles = output.split("\0").filter(Boolean);
    for (const relativePath of changedFiles) {
      const target = assertSafeRelativeFile(resolvedRoot, relativePath);
      const source = assertSafeRelativeFile(integration.path, relativePath);
      const backup = assertSafeRelativeFile(backupRoot, relativePath);
      if (await exists(target)) {
        await mkdir(path.dirname(backup), { recursive: true });
        const targetStat = await lstat(target);
        if (targetStat.isDirectory()) {
          await cp(target, backup, { recursive: true });
        } else {
          await copyFile(target, backup);
        }
      }
      if (await exists(source)) {
        const sourceStat = await lstat(source);
        await mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.vex-${process.pid}.tmp`;
        await rm(temporary, { recursive: true, force: true });
        if (sourceStat.isDirectory()) {
          await cp(source, temporary, { recursive: true });
        } else {
          await copyFile(source, temporary);
        }
        await rm(target, { recursive: true, force: true });
        await rename(temporary, target);
      } else {
        await rm(target, { recursive: true, force: true });
      }
    }
    return this.head(integration);
  }

  async removeManagedRepository(executionRoot: string): Promise<boolean> {
    const resolvedBase = path.resolve(this.managedBase);
    const resolvedExecutionRoot = path.resolve(executionRoot);
    const relative = path.relative(resolvedBase, resolvedExecutionRoot);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      path.basename(resolvedExecutionRoot) !== "repository"
    ) {
      return false;
    }
    await rm(path.dirname(resolvedExecutionRoot), {
      recursive: true,
      force: true,
    });
    return true;
  }

  async diff(
    root: string,
    baseRef: string,
    integrationRef: string,
  ): Promise<string> {
    const summary = await this.git.output(root, [
      "diff",
      "--stat",
      `${baseRef}..${integrationRef}`,
    ]);
    const files = await this.git.output(root, [
      "diff",
      "--name-status",
      `${baseRef}..${integrationRef}`,
    ]);
    return [summary, files].filter(Boolean).join("\n\n");
  }

  async remove(root: string, worktree: WorktreeRecord): Promise<void> {
    const remaining = await this.removeMany(root, [worktree]);
    if (remaining.length > 0) {
      throw new Error(
        `Could not fully remove VEX worktree ${worktree.path} (${worktree.branch})`,
      );
    }
  }

  async removeMany(
    root: string,
    worktrees: readonly WorktreeRecord[],
  ): Promise<WorktreeRecord[]> {
    for (const worktree of worktrees) {
      await this.git.run(
        root,
        ["worktree", "remove", "--force", worktree.path],
        true,
      );
      await this.git.run(root, ["branch", "-D", worktree.branch], true);
    }
    await this.git.run(root, ["worktree", "prune"], true);
    const worktreeList = await this.git.output(root, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const registered = new Set(
      worktreeList
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) =>
        path
          .resolve(line.slice("worktree ".length))
          .replaceAll("\\", "/")
          .toLowerCase(),
      ),
    );
    const branchOutput = await this.git.output(root, [
      "for-each-ref",
      "--format=%(refname)",
      "refs/heads",
    ]);
    const branches = new Set(branchOutput.split(/\r?\n/).filter(Boolean));
    return worktrees.filter((worktree) => {
      const normalizedTarget = path
        .resolve(worktree.path)
        .replaceAll("\\", "/")
        .toLowerCase();
      return (
        registered.has(normalizedTarget) ||
        branches.has(`refs/heads/${worktree.branch}`)
      );
    });
  }
}
