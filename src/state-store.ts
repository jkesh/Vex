import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { GitClient } from "./git.js";
import type { VexRunState } from "./types.js";

export class RunStateStore {
  constructor(
    readonly git = new GitClient(),
    readonly directoryName = "vex",
  ) {}

  async runDirectory(root: string, runId: string): Promise<string> {
    const commonDirectory = await this.git.output(root, [
      "rev-parse",
      "--git-common-dir",
    ]);
    const absoluteCommonDirectory = path.isAbsolute(commonDirectory)
      ? commonDirectory
      : path.resolve(root, commonDirectory);
    return path.join(
      absoluteCommonDirectory,
      this.directoryName,
      "runs",
      runId,
    );
  }

  async save(state: VexRunState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    const directory = await this.runDirectory(state.root, state.id);
    const target = path.join(directory, "state.json");
    const temporary = `${target}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, target);
  }

  async load(root: string, runId: string): Promise<VexRunState> {
    const content = await readFile(
      path.join(await this.runDirectory(root, runId), "state.json"),
      "utf8",
    );
    return JSON.parse(content) as VexRunState;
  }

  async latest(root: string): Promise<VexRunState | undefined> {
    const sampleRunDirectory = await this.runDirectory(root, "__lookup__");
    const runsDirectory = path.dirname(sampleRunDirectory);
    let runIds: string[];
    try {
      runIds = await readdir(runsDirectory);
    } catch {
      return undefined;
    }

    const states = await Promise.all(
      runIds.map(async (runId) => {
        try {
          return await this.load(root, runId);
        } catch {
          return undefined;
        }
      }),
    );
    return states
      .filter((state): state is VexRunState => state !== undefined)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }
}
