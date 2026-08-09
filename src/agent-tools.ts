import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ShellProjectCommandRunner } from "./command-runner.js";
import { matchesOwnedPath } from "./policy.js";
import type { RoleRunInput } from "./types.js";

export interface AgentToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const definitions: Record<string, AgentToolDefinition> = {
  read: {
    type: "function",
    function: {
      name: "read",
      description: "Read a UTF-8 text file in the current repository worktree.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          offset: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 2000 },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
  },
  ls: {
    type: "function",
    function: {
      name: "ls",
      description: "List files and directories without changing them.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
        },
        additionalProperties: false,
      },
    },
  },
  find: {
    type: "function",
    function: {
      name: "find",
      description: "Find repository files by a glob-like path pattern.",
      parameters: {
        type: "object",
        properties: { pattern: { type: "string" }, path: { type: "string" } },
        required: ["pattern"],
        additionalProperties: false,
      },
    },
  },
  grep: {
    type: "function",
    function: {
      name: "grep",
      description: "Search UTF-8 repository files for text or a regular expression.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          path: { type: "string" },
          regex: { type: "boolean" },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
  },
  bash: {
    type: "function",
    function: {
      name: "bash",
      description:
        "Run a non-interactive shell command in the assigned worktree. Destructive, publishing, credential, and direct file-writing commands are blocked.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
        additionalProperties: false,
      },
    },
  },
  write: {
    type: "function",
    function: {
      name: "write",
      description: "Create or replace one UTF-8 file inside the assignment paths.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
        additionalProperties: false,
      },
    },
  },
  edit: {
    type: "function",
    function: {
      name: "edit",
      description: "Replace exact text in one file inside the assignment paths.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string" },
          oldText: { type: "string" },
          newText: { type: "string" },
          all: { type: "boolean" },
        },
        required: ["path", "oldText", "newText"],
        additionalProperties: false,
      },
    },
  },
  team_yield: {
    type: "function",
    function: {
      name: "team_yield",
      description: "Return the role's final structured result to VEX and stop.",
      parameters: {
        type: "object",
        properties: {
          role: {
            type: "string",
            enum: [
              "scout",
              "architect",
              "backend",
              "frontend",
              "test-engineer",
              "reviewer",
              "security-reviewer",
            ],
          },
          status: {
            type: "string",
            enum: ["completed", "skipped", "blocked", "failed"],
          },
          summary: { type: "string" },
          artifacts: { type: "array", items: { type: "string" } },
          payload: {},
        },
        required: ["role", "status", "summary", "artifacts"],
        additionalProperties: false,
      },
    },
  },
};

export function toolDefinitions(names: readonly string[]): AgentToolDefinition[] {
  return names.map((name) => {
    const definition = definitions[name];
    if (!definition) throw new Error(`VEX has no native tool implementation: ${name}`);
    return definition;
  });
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${name} must be a string`);
  return value;
}

function safeTarget(cwd: string, rawPath: string, allowRoot = false): string {
  const root = path.resolve(cwd);
  const target = path.resolve(root, rawPath || ".");
  const relative = path.relative(root, target).replaceAll("\\", "/");
  if (
    (!allowRoot && !relative) ||
    relative.startsWith("../") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes the assigned worktree: ${rawPath}`);
  }
  return target;
}

function relativeTo(cwd: string, target: string): string {
  return path.relative(path.resolve(cwd), target).replaceAll("\\", "/");
}

function protectedPath(relative: string): boolean {
  return /(^|\/)\.(?:git|vex)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:pem|key|p12|pfx)$/i.test(
    relative,
  );
}

function assertReadable(input: RoleRunInput, target: string): void {
  const relative = relativeTo(input.cwd, target);
  if (protectedPath(relative)) throw new Error(`Protected path: ${relative}`);
}

function allowedPaths(input: RoleRunInput): string[] {
  const assignment = input.context.assignment;
  if (!assignment || typeof assignment !== "object") return [];
  const value = (assignment as { allowedPaths?: unknown }).allowedPaths;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function assertWritable(input: RoleRunInput, target: string): void {
  if (!input.role.writes) throw new Error(`${input.role.name} is read-only`);
  const relative = relativeTo(input.cwd, target);
  if (protectedPath(relative)) {
    throw new Error(`Protected path: ${relative}`);
  }
  const allowed = allowedPaths(input);
  if (!allowed.some((pattern) => matchesOwnedPath(relative, pattern))) {
    throw new Error(`${relative} is outside this role's allowed paths`);
  }
}

const SKIPPED_DIRECTORIES = new Set([
  ".git",
  ".vex",
  "node_modules",
  ".vex-worktrees",
]);

async function walk(directory: string, limit = 2_000): Promise<string[]> {
  const result: string[] = [];
  const pending = [directory];
  while (pending.length > 0 && result.length < limit) {
    const current = pending.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        SKIPPED_DIRECTORIES.has(entry.name) ||
        /^\.env(?:\.|$)/i.test(entry.name) ||
        /\.(?:pem|key|p12|pfx)$/i.test(entry.name)
      ) continue;
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) result.push(target);
      if (result.length >= limit) break;
    }
  }
  return result;
}

function globRegex(pattern: string): RegExp {
  const normalized = pattern.replaceAll("\\", "/");
  let expression = "";
  for (let index = 0; index < normalized.length; index++) {
    const character = normalized[index]!;
    if (character === "*" && normalized[index + 1] === "*") {
      expression += ".*";
      index++;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
  }
  return new RegExp(`^${expression}$`, "i");
}

function shellPolicy(command: string, writes: boolean): string | undefined {
  const alwaysBlocked =
    /\bgit\s+(?:push|rebase|reset\s+--hard|clean\s+-[^\s]*[fdx]|worktree\s+remove)\b|(?:^|[;&|]\s*)(?:rm|del|erase|rmdir|remove-item)\b|(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:publish|login)\b|(?:^|[;&|]\s*)(?:ssh|scp)\b/i;
  if (alwaysBlocked.test(command)) return "destructive, publishing, and credential commands are blocked";
  if (
    /(?:^|[;&|]\s*)(?:curl|wget|iwr|invoke-webrequest|nc|ncat|telnet)\b|(?:^|[;&|]\s*)(?:env|printenv)\b|(?:cat|type|get-content)\s+[^;&|]*(?:\.env|\.pem|\.key|\.p12|\.pfx)/i.test(
      command,
    )
  ) {
    return "network access and secret inspection are blocked inside Agent shell tools";
  }
  const directWrite =
    /(?:^|[^<])(?:>>?|2>|&>)\s*[^&]|(?:^|[;&|]\s*)(?:touch|cp|mv|mkdir|new-item|set-content|add-content)\b/i;
  if (directWrite.test(command)) {
    return "direct shell file writes are blocked; use the scoped write/edit tools";
  }
  if (
    !writes &&
    /\bgit\s+(?:add|commit|checkout|switch|merge|cherry-pick|rebase|reset|clean|worktree|branch|tag|stash|apply|am)\b/i.test(
      command,
    )
  ) {
    return "this role is read-only";
  }
  return undefined;
}

function truncate(value: string, limit = 24_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n... truncated by VEX`;
}

function sanitizedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      !/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|COOKIE|AUTH)|^(?:AWS|AZURE|GOOGLE|GITHUB|SSH)_/i.test(
        name,
      ),
    ),
  );
}

export class NativeAgentToolExecutor {
  readonly #shell = new ShellProjectCommandRunner();

  async execute(
    name: string,
    rawArguments: unknown,
    input: RoleRunInput,
    signal?: AbortSignal,
  ): Promise<string> {
    const args = isObject(rawArguments) ? rawArguments : {};
    if (!input.role.tools.includes(name)) throw new Error(`${name} is not available to ${input.role.name}`);
    if (name === "read") {
      const target = safeTarget(input.cwd, text(args.path, "path"));
      assertReadable(input, target);
      const content = await readFile(target, "utf8");
      const lines = content.split(/\r?\n/);
      const offset = typeof args.offset === "number" ? Math.max(1, Math.trunc(args.offset)) : 1;
      const limit = typeof args.limit === "number" ? Math.min(2_000, Math.max(1, Math.trunc(args.limit))) : 400;
      return truncate(
        lines
          .slice(offset - 1, offset - 1 + limit)
          .map((line, index) => `${offset + index}: ${line}`)
          .join("\n"),
      );
    }
    if (name === "ls") {
      const target = safeTarget(
        input.cwd,
        typeof args.path === "string" ? args.path : ".",
        true,
      );
      assertReadable(input, target);
      if (args.recursive === true) {
        return truncate(
          (await walk(target)).map((file) => relativeTo(input.cwd, file)).join("\n"),
        );
      }
      const entries = await readdir(target, { withFileTypes: true });
      return entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => `${entry.isDirectory() ? "d" : "f"} ${entry.name}`)
        .join("\n");
    }
    if (name === "find") {
      const base = safeTarget(
        input.cwd,
        typeof args.path === "string" ? args.path : ".",
        true,
      );
      assertReadable(input, base);
      const matcher = globRegex(text(args.pattern, "pattern"));
      return truncate(
        (await walk(base))
          .map((file) => relativeTo(input.cwd, file))
          .filter((file) => matcher.test(file) || matcher.test(path.basename(file)))
          .join("\n"),
      );
    }
    if (name === "grep") {
      const base = safeTarget(
        input.cwd,
        typeof args.path === "string" ? args.path : ".",
        true,
      );
      assertReadable(input, base);
      const query = text(args.query, "query");
      const matcher = args.regex === true ? new RegExp(query) : undefined;
      const matches: string[] = [];
      for (const file of await walk(base)) {
        if (matches.length >= 1_000) break;
        let info;
        try {
          info = await stat(file);
          if (info.size > 1_000_000) continue;
          const content = await readFile(file, "utf8");
          if (content.includes("\0")) continue;
          content.split(/\r?\n/).forEach((line, index) => {
            if ((matcher ? matcher.test(line) : line.includes(query)) && matches.length < 1_000) {
              matches.push(`${relativeTo(input.cwd, file)}:${index + 1}:${line}`);
            }
          });
        } catch {
          continue;
        }
      }
      return truncate(matches.join("\n"));
    }
    if (name === "bash") {
      const command = text(args.command, "command");
      const violation = shellPolicy(command, input.role.writes);
      if (violation) throw new Error(violation);
      const result = await this.#shell.run(
        command,
        input.cwd,
        signal,
        sanitizedEnvironment(),
      );
      return truncate(
        `exit=${result.exitCode}\n${result.stdout}${result.stderr ? `\nstderr:\n${result.stderr}` : ""}`,
      );
    }
    if (name === "write") {
      const target = safeTarget(input.cwd, text(args.path, "path"));
      assertWritable(input, target);
      await mkdir(path.dirname(target), { recursive: true });
      const content = typeof args.content === "string" ? args.content : "";
      await writeFile(target, content, "utf8");
      return `wrote ${Buffer.byteLength(content)} bytes to ${relativeTo(input.cwd, target)}`;
    }
    if (name === "edit") {
      const target = safeTarget(input.cwd, text(args.path, "path"));
      assertWritable(input, target);
      const oldText = text(args.oldText, "oldText");
      const newText = typeof args.newText === "string" ? args.newText : "";
      const content = await readFile(target, "utf8");
      if (!content.includes(oldText)) throw new Error("oldText was not found exactly");
      if (args.all !== true && content.indexOf(oldText) !== content.lastIndexOf(oldText)) {
        throw new Error("oldText occurs more than once; provide more context or set all=true");
      }
      const updated = args.all === true
        ? content.replaceAll(oldText, newText)
        : content.replace(oldText, newText);
      await writeFile(target, updated, "utf8");
      return `edited ${relativeTo(input.cwd, target)}`;
    }
    throw new Error(`Tool ${name} must be handled by the native agent runner`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
