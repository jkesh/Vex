import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createInteractiveCompleter,
  createInteractiveHintProvider,
  interactiveHelp,
  isDirectExecution,
  modelTargetItems,
  parseCliArguments,
  parseInteractiveInput,
} from "../src/cli.js";
import {
  diffTerminalRows,
  filterSelectItems,
  parseSgrMouseEvents,
  PromptHistory,
  renderHome,
  SelectorInputDecoder,
  selectorVisibleRows,
} from "../src/cli-ui.js";

describe("standalone CLI argument parser", () => {
  test("recalls prompt history with draft restoration and bounded deduplication", () => {
    const history = new PromptHistory(3);
    history.push("/providers");
    history.push("/providers");
    history.push("review this repository");
    history.push("/routing");
    history.begin("draft");

    expect(history.previous("draft")).toBe("/routing");
    expect(history.previous("/routing")).toBe("review this repository");
    expect(history.previous("review this repository")).toBe("/providers");
    expect(history.previous("/providers")).toBeUndefined();
    expect(history.next()).toBe("review this repository");
    expect(history.next()).toBe("/routing");
    expect(history.next()).toBe("draft");
    expect(history.next()).toBeUndefined();
  });

  test("opens the workspace without arguments", () => {
    expect(parseCliArguments([]).command).toBe("interactive");
    expect(parseCliArguments(["connect", "openai"])).toMatchObject({
      command: "provider",
      values: ["openai"],
    });
    expect(parseCliArguments(["connect", "openai", "browser"])).toMatchObject({
      command: "provider",
      values: ["openai", "browser"],
    });
  });

  test("parses native run controls without external presets", () => {
    expect(
      parseCliArguments([
        "run",
        "--model",
        "company/coder",
        "--security",
        "--trust-project",
        "implement",
        "it",
      ]),
    ).toEqual({
      command: "run",
      values: ["implement", "it"],
      options: {
        model: "company/coder",
        securityReview: true,
        projectTrusted: true,
        yes: false,
        json: false,
        global: false,
      },
    });
    expect(() => parseCliArguments(["run", "--preset", "omo", "task"])).toThrow(
      "Unknown option",
    );
  });

  test("routes an unrecognized command through semantic auto mode", () => {
    expect(parseCliArguments(["fix", "the", "tests"])).toMatchObject({
      command: "auto",
      values: ["fix", "the", "tests"],
    });
    expect(parseCliArguments(["chat", "explain", "worktrees"])).toMatchObject({
      command: "chat",
      values: ["explain", "worktrees"],
    });
    expect(parseCliArguments(["assess", "the", "architecture"])).toMatchObject({
      command: "assess",
      values: ["the", "architecture"],
    });
    expect(parseCliArguments(["code-review", "src"])).toMatchObject({
      command: "code-review",
      values: ["src"],
    });
  });

  test("preserves natural-language input for mode routing", () => {
    expect(parseInteractiveInput("修复登录页并补充测试")).toMatchObject({
      kind: "prompt",
      text: "修复登录页并补充测试",
    });
  });

  test("routes slash commands without a numbered menu", () => {
    expect(parseInteractiveInput("/plan inspect the API")).toMatchObject({
      kind: "invoke",
      invocation: { command: "plan", values: ["inspect the API"] },
    });
    expect(parseInteractiveInput("/security harden auth")).toMatchObject({
      kind: "invoke",
      invocation: {
        command: "run",
        values: ["harden auth"],
        options: { securityReview: true },
      },
    });
    expect(parseInteractiveInput("/mode review")).toEqual({
      kind: "set-mode",
      mode: "review",
    });
    expect(parseInteractiveInput("/chat explain worktrees")).toMatchObject({
      kind: "invoke",
      invocation: { command: "chat", values: ["explain worktrees"] },
    });
    expect(parseInteractiveInput("/assess architecture risks")).toMatchObject({
      kind: "invoke",
      invocation: { command: "assess", values: ["architecture risks"] },
    });
    expect(parseInteractiveInput("/code-review authentication")).toMatchObject({
      kind: "invoke",
      invocation: { command: "code-review", values: ["authentication"] },
    });
    expect(parseInteractiveInput("/status run-1")).toMatchObject({
      kind: "invoke",
      invocation: { command: "status", values: ["run-1"] },
    });
    expect(parseInteractiveInput("/usage run-1")).toMatchObject({
      kind: "invoke",
      invocation: { command: "usage", values: ["run-1"] },
    });
    expect(parseInteractiveInput("/login openai")).toEqual({
      kind: "unknown",
      command: "/login",
    });
    expect(parseInteractiveInput("/connect openai browser")).toEqual({
      kind: "unknown",
      command: "/connect",
    });
    expect(parseInteractiveInput("/models openrouter")).toMatchObject({
      kind: "invoke",
      invocation: { command: "models", values: ["openrouter"] },
    });
    expect(parseInteractiveInput("/provider openrouter")).toEqual({
      kind: "set-provider",
      provider: "openrouter",
      method: "",
    });
    expect(parseInteractiveInput("/provider openai oauth")).toEqual({
      kind: "set-provider",
      provider: "openai",
      method: "oauth",
    });
    expect(parseInteractiveInput("/model gpt-coder")).toEqual({
      kind: "set-model",
      model: "gpt-coder",
    });
    expect(parseInteractiveInput("/model")).toEqual({
      kind: "set-model",
      model: "",
    });
    expect(
      parseInteractiveInput("/route architect openai reasoning-model"),
    ).toEqual({
      kind: "set-route",
      role: "architect",
      provider: "openai",
      model: "reasoning-model",
    });
    expect(parseInteractiveInput("/quit")).toEqual({ kind: "quit" });
    expect(parseInteractiveInput("/unknown")).toEqual({
      kind: "unknown",
      command: "/unknown",
    });
  });

  test("filters Provider and model pickers by labels, keywords, and details", () => {
    const items = [
      {
        value: "openai",
        label: "OpenAI (openai)",
        description: "API key saved · https://api.openai.com/v1",
        keywords: ["openai"],
      },
      {
        value: "openrouter",
        label: "OpenRouter (openrouter)",
        description: "login required · https://openrouter.ai/api/v1",
        keywords: ["router", "openrouter"],
      },
    ];
    expect(filterSelectItems(items, "router").map((item) => item.value)).toEqual([
      "openrouter",
    ]);
    expect(filterSelectItems(items, "saved").map((item) => item.value)).toEqual([
      "openai",
    ]);
    expect(filterSelectItems(items, "OPENAI").map((item) => item.value)).toEqual([
      "openai",
    ]);
  });

  test("completes slash commands, Providers, modes, roles, and discovered models", () => {
    const complete = createInteractiveCompleter({
      providers: ["openai", "anthropic", "deepseek", "newapi", "sub2api"],
      models: [
        { provider: "anthropic", model: "claude-sonnet" },
        { provider: "deepseek", model: "deepseek-chat" },
      ],
    });
    expect(complete("/mo")[0]).toEqual([
      "/mode ",
      "/model ",
      "/models ",
    ]);
    expect(complete("/us")[0]).toEqual(["/usage "]);
    expect(complete("/mode r")[0]).toEqual(["/mode review"]);
    expect(complete("/mode code")[0]).toEqual(["/mode code-review"]);
    expect(complete("/provider an")[0]).toEqual(["/provider anthropic "]);
    expect(complete("/provider openai o")[0]).toEqual([
      "/provider openai oauth",
    ]);
    expect(complete("/login")[0]).toEqual([]);
    expect(interactiveHelp()).toContain("/provider [id] [oauth|api-key]");
    expect(interactiveHelp()).toContain(
      "assign models to targets repeatedly; Esc finishes",
    );
    expect(interactiveHelp()).not.toContain("/login");
    expect(interactiveHelp()).toContain(
      "/usage [run-id]    show Token use by Agent, Provider, and model",
    );
    expect(complete("/model cla")[0]).toEqual(["/model claude-sonnet"]);
    expect(complete("/route architect anth")[0]).toEqual([
      "/route architect anthropic ",
    ]);
    expect(complete("/route architect anthropic cla")[0]).toEqual([
      "/route architect anthropic claude-sonnet",
    ]);
  });

  test("shows prioritized live hints for commands and their parameters", () => {
    const hints = createInteractiveHintProvider({
      providers: ["openai", "anthropic", "deepseek"],
      models: [
        { provider: "anthropic", model: "claude-sonnet" },
        { provider: "deepseek", model: "deepseek-chat" },
      ],
    });
    expect(hints("/").slice(0, 8).map((hint) => hint.value.trim())).toEqual([
      "/provider",
      "/model",
      "/mode",
      "/route",
      "/chat",
      "/code-review",
      "/assess",
      "/run",
    ]);
    expect(hints("/mode")[0]).toEqual({
      value: "/mode ",
      description: "select auto, chat, review, code-review, or implement",
    });
    expect(hints("/provider an")[0]).toEqual({
      value: "/provider anthropic ",
      description: "Claude (Anthropic) Provider",
    });
    expect(hints("/provider openai o")[0]).toEqual({
      value: "/provider openai oauth",
      description: "browser authorization; no API key required",
    });
    expect(hints("/mode r")[0]).toEqual({
      value: "/mode review",
      description: "read-only Scout and Technical Reviewer",
    });
    expect(hints("/mode code")[0]).toEqual({
      value: "/mode code-review",
      description: "read-only Reviewer only; no Scout or writers",
    });
    expect(hints("/route arch")[0]).toEqual({
      value: "/route architect ",
      description: expect.stringContaining("plan"),
    });
    expect(hints("/model cla")[0]).toEqual({
      value: "/model claude-sonnet",
      description: "Claude (Anthropic) model",
    });
    expect(hints("explain this")).toEqual([]);
  });

  test("renders an adaptive natural-language entrypoint instead of choices", () => {
    const home = renderHome({
      root: "D:\\workspace",
      kind: "directory",
      branch: "",
      head: "",
      dirty: false,
    });
    expect(home).toContain("auto selects chat, review, code-review, or implement");
    expect(home).toContain("/mode auto|chat|review|code-review|implement");
    expect(home).toContain("/provider");
    expect(home).toContain("Type / for hints");
    expect(interactiveHelp()).toContain("Use Up/Down to choose and Tab to complete");
    expect(interactiveHelp()).toContain("Up recalls history");
    expect(home).toContain("two-pane model selector");
    expect(home).toContain("/route (per-role routing)");
    expect(home).not.toContain("1  Run a task");
    expect(home).not.toContain("Choose 1");
  });

  test("parses SGR mouse clicks, releases, and wheel events", () => {
    expect(
      parseSgrMouseEvents("\x1b[<0;42;8M\x1b[<0;42;8m\x1b[<65;18;10M"),
    ).toEqual([
      { button: 0, column: 42, row: 8, release: false },
      { button: 0, column: 42, row: 8, release: true },
      { button: 65, column: 18, row: 10, release: false },
    ]);
  });

  test("decodes split arrow keys and mouse packets for the model selector", () => {
    const decoder = new SelectorInputDecoder();
    expect(decoder.push("\x1b[")).toEqual([]);
    expect(decoder.push("A\x1b[B\x1bOD\x1b[1;5C")).toEqual([
      { type: "key", name: "up" },
      { type: "key", name: "down" },
      { type: "key", name: "left" },
      { type: "key", name: "right" },
    ]);
    expect(decoder.push("\x1b[<0;42;")).toEqual([]);
    expect(decoder.push("8M\x1b[<0;42;8m")).toEqual([
      {
        type: "mouse",
        mouse: { button: 0, column: 42, row: 8, release: false },
      },
      {
        type: "mouse",
        mouse: { button: 0, column: 42, row: 8, release: true },
      },
    ]);
  });

  test("updates selector rows in place without growing terminal history", () => {
    expect(diffTerminalRows([], ["first", "second"])).toBe(
      "\x1b[1;1H\x1b[2Kfirst\x1b[2;1H\x1b[2Ksecond",
    );
    expect(diffTerminalRows(["first", "second"], ["first", "changed"]))
      .toBe("\x1b[2;1H\x1b[2Kchanged");
    expect(diffTerminalRows(["first", "second"], ["first"]))
      .toBe("\x1b[2;1H\x1b[2K");
    expect(selectorVisibleRows(24)).toBe(14);
    expect(selectorVisibleRows(12)).toBe(4);
    expect(selectorVisibleRows(6)).toBe(1);
  });

  test("restores saved model assignments in the target selector", () => {
    const routes = {
      "session-default": {
        provider: "deepseek",
        model: "deepseek-v4-flash",
      },
      reviewer: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
      },
    } as const;
    const items = modelTargetItems(true, routes);
    expect(items.find((item) => item.value === "session-default")?.description)
      .toContain("current deepseek/deepseek-v4-flash");
    expect(items.find((item) => item.value === "reviewer")?.description)
      .toContain("current anthropic/claude-sonnet-4-5");
    expect(items.find((item) => item.value === "backend")?.description)
      .toContain("inherits deepseek/deepseek-v4-flash");
  });

  test("recognizes execution through an npm-style directory link", async () => {
    const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "vex-cli-"));
    const realPackage = path.join(temporaryRoot, "package");
    const linkedPackage = path.join(temporaryRoot, "linked-package");
    const cliPath = path.join(realPackage, "dist", "cli.js");

    try {
      await mkdir(path.dirname(cliPath), { recursive: true });
      await writeFile(cliPath, "// fixture\n");
      await symlink(
        realPackage,
        linkedPackage,
        process.platform === "win32" ? "junction" : "dir",
      );

      expect(
        isDirectExecution(
          path.join(linkedPackage, "dist", "cli.js"),
          pathToFileURL(cliPath).href,
        ),
      ).toBe(true);
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  });
});
