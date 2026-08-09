import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { CommandResult } from "./types.js";

export interface ProjectCommandRunner {
  run(
    command: string,
    cwd: string,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
  ): Promise<CommandResult>;
}

export function terminateProcessTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  terminatePidTree(child.pid);
}

export function terminatePidTree(pid: number): void {
  if (process.platform === "win32") {
    execFile(
      "taskkill",
      ["/pid", String(pid), "/T", "/F"],
      { windowsHide: true },
      () => undefined,
    );
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    process.kill(pid, "SIGTERM");
  }
}

export class ShellProjectCommandRunner implements ProjectCommandRunner {
  async run(
    command: string,
    cwd: string,
    signal?: AbortSignal,
    environment?: NodeJS.ProcessEnv,
  ): Promise<CommandResult> {
    const startedAt = new Date().toISOString();
    return new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, {
        cwd,
        ...(environment ? { env: environment } : {}),
        shell: true,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const limit = 8 * 1024 * 1024;
      child.stdout?.on("data", (data: Buffer) => {
        if (stdout.length < limit) stdout += data.toString("utf8");
      });
      child.stderr?.on("data", (data: Buffer) => {
        if (stderr.length < limit) stderr += data.toString("utf8");
      });
      const abort = () => terminateProcessTree(child);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      child.once("error", reject);
      child.once("close", (code) => {
        signal?.removeEventListener("abort", abort);
        resolve({
          command,
          cwd,
          exitCode: code ?? 1,
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      });
    });
  }
}
