import { afterEach, describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createVexExtension } from "../extensions/vex/index.js";

const originalChildFlag = process.env.VEX_CHILD;

afterEach(() => {
  if (originalChildFlag === undefined) delete process.env.VEX_CHILD;
  else process.env.VEX_CHILD = originalChildFlag;
  delete process.env.VEX_ROLE;
});

describe("Pi extension entrypoint", () => {
  test("registers the public command surface in the parent session", async () => {
    delete process.env.VEX_CHILD;
    const commands: string[] = [];
    const pi = {
      registerCommand(name: string) {
        commands.push(name);
      },
    } as unknown as ExtensionAPI;

    await createVexExtension()(pi);
    expect(commands.sort()).toEqual([
      "code",
      "vex",
      "vex-abort",
      "vex-cleanup",
      "vex-status",
    ]);
  });

  test("exposes only team_yield in a child session", async () => {
    process.env.VEX_CHILD = "1";
    const tools: string[] = [];
    const commands: string[] = [];
    const pi = {
      registerTool(tool: { name: string }) {
        tools.push(tool.name);
      },
      registerCommand(name: string) {
        commands.push(name);
      },
    } as unknown as ExtensionAPI;

    await createVexExtension()(pi);
    expect(tools).toEqual(["team_yield"]);
    expect(commands).toEqual([]);
  });
});
