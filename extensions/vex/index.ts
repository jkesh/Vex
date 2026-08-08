import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  RoleKnowledgeClient,
  type RoleKnowledgeProvider,
} from "../../src/knowledge.js";
import { VexOrchestrator } from "../../src/orchestrator.js";
import { FileOwnershipPolicy } from "../../src/policy.js";
import { loadRoles } from "../../src/roles.js";
import { PiChildRunner, TEAM_YIELD_MARKER } from "../../src/runner.js";
import { formatRunState, VexService } from "../../src/service.js";
import { RunStateStore } from "../../src/state-store.js";
import { WorktreeManager } from "../../src/worktrees.js";

export interface VexExtensionOptions {
  knowledgeProvider?: RoleKnowledgeProvider;
  piCommand?: string;
  piCommandArguments?: string[];
}

const roleSchema = Type.Union([
  Type.Literal("scout"),
  Type.Literal("architect"),
  Type.Literal("backend"),
  Type.Literal("frontend"),
  Type.Literal("test-engineer"),
  Type.Literal("reviewer"),
  Type.Literal("security-reviewer"),
]);

function registerTeamYield(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "team_yield",
    label: "Yield to VEX",
    description:
      "Return the fixed role's structured result to the VEX orchestrator and end the child session.",
    parameters: Type.Object({
      role: roleSchema,
      status: Type.Union([
        Type.Literal("completed"),
        Type.Literal("skipped"),
        Type.Literal("blocked"),
        Type.Literal("failed"),
      ]),
      summary: Type.String({ minLength: 1 }),
      artifacts: Type.Array(Type.String()),
      payload: Type.Optional(Type.Unknown()),
    }),
    async execute(_toolCallId, params) {
      const expectedRole = process.env.VEX_ROLE;
      if (expectedRole && params.role !== expectedRole) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Role mismatch: expected ${expectedRole}, received ${params.role}`,
            },
          ],
          details: params,
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `${TEAM_YIELD_MARKER}${JSON.stringify(params)}`,
          },
        ],
        details: params,
        terminate: true,
      };
    },
  });
}

function parseTaskArguments(args: string): {
  task: string;
  securityReview: boolean;
} {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  const securityReview = tokens.includes("--security");
  return {
    task: tokens.filter((token) => token !== "--security").join(" "),
    securityReview,
  };
}

export function createVexExtension(options: VexExtensionOptions = {}) {
  return async function vexExtension(pi: ExtensionAPI): Promise<void> {
    if (process.env.VEX_CHILD === "1") {
      registerTeamYield(pi);
      return;
    }

    const extensionPath = fileURLToPath(import.meta.url);
    const packageRoot = path.resolve(path.dirname(extensionPath), "../..");
    const roles = await loadRoles(path.join(packageRoot, "roles"));
    const store = new RunStateStore();
    const worktrees = new WorktreeManager();
    const orchestrator = new VexOrchestrator({
      roles,
      runner: new PiChildRunner({
        extensionPath,
        ...(options.piCommand ? { command: options.piCommand } : {}),
        ...(options.piCommandArguments
          ? { commandArguments: options.piCommandArguments }
          : {}),
      }),
      knowledge: new RoleKnowledgeClient(options.knowledgeProvider),
      worktrees,
      policy: new FileOwnershipPolicy(),
      store,
    });
    const service = new VexService(orchestrator, store, worktrees);

    const start = async (args: string, ctx: ExtensionCommandContext) => {
      const parsed = parseTaskArguments(args);
      if (!parsed.task) {
        ctx.ui.notify("Usage: /vex [--security] <coding task>", "warning");
        return;
      }
      try {
        const active = service.start(ctx.cwd, parsed.task, {
          securityReview: parsed.securityReview,
        });
        ctx.ui.notify(`VEX ${active.id} started`, "info");
        void active.promise.then(
          (state) => ctx.ui.notify(formatRunState(state), "info"),
          (error) =>
            ctx.ui.notify(
              `VEX ${active.id} failed: ${error instanceof Error ? error.message : String(error)}`,
              "error",
            ),
        );
      } catch (error) {
        ctx.ui.notify(
          error instanceof Error ? error.message : String(error),
          "error",
        );
      }
    };

    pi.registerCommand("vex", {
      description: "Run the fixed-role VEX coding team",
      handler: start,
    });
    pi.registerCommand("code", {
      description: "Alias for /vex",
      handler: start,
    });
    pi.registerCommand("vex-status", {
      description: "Show the latest VEX run state",
      handler: async (_args, ctx) => {
        try {
          const state = await service.status(ctx.cwd);
          ctx.ui.notify(
            state ? formatRunState(state) : "No VEX runs found",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    });
    pi.registerCommand("vex-abort", {
      description: "Abort the active VEX run",
      handler: async (_args, ctx) => {
        const runId = service.abort();
        ctx.ui.notify(
          runId ? `Abort requested for VEX ${runId}` : "No active VEX run",
          runId ? "warning" : "info",
        );
      },
    });
    pi.registerCommand("vex-cleanup", {
      description:
        "Remove worktrees left by the latest failed or aborted VEX run",
      handler: async (_args, ctx) => {
        try {
          const count = await service.cleanup(ctx.cwd);
          ctx.ui.notify(
            `Removed ${count} VEX worktree${count === 1 ? "" : "s"}`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            error instanceof Error ? error.message : String(error),
            "error",
          );
        }
      },
    });
  };
}

export default createVexExtension();
