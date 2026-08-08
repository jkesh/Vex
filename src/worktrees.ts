import { mkdir } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "./git.js";
import type { WorktreeOwner, WorktreeRecord } from "./types.js";

export interface RepositorySnapshot {
  root: string;
  branch: string;
  head: string;
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
  ) {}

  async inspectRepository(cwd: string): Promise<RepositorySnapshot> {
    const root = path.resolve(
      await this.git.output(cwd, ["rev-parse", "--show-toplevel"]),
    );
    const branch = await this.git.output(root, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    const head = await this.git.output(root, ["rev-parse", "HEAD"]);
    const status = await this.git.output(root, [
      "status",
      "--porcelain",
      "--untracked-files=normal",
    ]);
    if (status)
      throw new Error(`VEX requires a clean working tree:\n${status}`);
    return { root, branch, head };
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
    const output = await this.git.output(worktree.path, [
      "rev-list",
      "--reverse",
      `${worktree.baseRef}..HEAD`,
    ]);
    return output ? output.split(/\r?\n/).filter(Boolean) : [];
  }

  async changedFiles(worktree: WorktreeRecord): Promise<string[]> {
    const output = await this.git.output(worktree.path, [
      "diff",
      "--name-only",
      "--diff-filter=ACMR",
      `${worktree.baseRef}..HEAD`,
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

  async finalize(
    root: string,
    expectedBase: string,
    integration: WorktreeRecord,
  ): Promise<string> {
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
    await this.git.run(root, ["merge", "--ff-only", integration.branch]);
    return this.git.output(root, ["rev-parse", "HEAD"]);
  }

  async remove(root: string, worktree: WorktreeRecord): Promise<void> {
    await this.git.run(
      root,
      ["worktree", "remove", "--force", worktree.path],
      true,
    );
    await this.git.run(root, ["branch", "-D", worktree.branch], true);
    await this.git.run(root, ["worktree", "prune"], true);
    const worktreeList = await this.git.output(root, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const normalizedTarget = path
      .resolve(worktree.path)
      .replaceAll("\\", "/")
      .toLowerCase();
    const stillRegistered = worktreeList
      .split(/\r?\n/)
      .filter((line) => line.startsWith("worktree "))
      .map((line) =>
        path
          .resolve(line.slice("worktree ".length))
          .replaceAll("\\", "/")
          .toLowerCase(),
      )
      .includes(normalizedTarget);
    const branchExists =
      (
        await this.git.run(
          root,
          ["show-ref", "--verify", "--quiet", `refs/heads/${worktree.branch}`],
          true,
        )
      ).exitCode === 0;
    if (stillRegistered || branchExists) {
      throw new Error(
        `Could not fully remove VEX worktree ${worktree.path} (${worktree.branch})`,
      );
    }
  }
}
