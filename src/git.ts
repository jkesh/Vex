import { execFile } from "node:child_process";

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitCommandError extends Error {
  constructor(
    readonly cwd: string,
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    );
    this.name = "GitCommandError";
  }
}

export class GitClient {
  async run(
    cwd: string,
    args: string[],
    allowFailure = false,
  ): Promise<GitResult> {
    const result = await new Promise<GitResult>((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd,
          encoding: "utf8",
          windowsHide: true,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          const exitCode =
            typeof error?.code === "number" ? error.code : error ? 1 : 0;
          resolve({ stdout, stderr, exitCode });
        },
      );
    });

    if (result.exitCode !== 0 && !allowFailure)
      throw new GitCommandError(cwd, args, result);
    return result;
  }

  async output(cwd: string, args: string[]): Promise<string> {
    return (await this.run(cwd, args)).stdout.trim();
  }
}
