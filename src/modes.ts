import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VexConfigLoader } from "./config.js";
import { vexFetch } from "./http-client.js";
import {
  completeProvider,
  type ProviderAuthResolver,
  type ProviderCompletion,
  type ProviderFetchLike,
  type ProviderMessage,
} from "./provider-transport.js";
import type {
  ModelRole,
  ProviderRuntimeConfig,
  ResolvedVexConfig,
  RoleDefinition,
  RoleRunResult,
  RoleRunner,
  RoleRuntimeConfig,
  ScoutReport,
  VexRunOptions,
} from "./types.js";
import type { WorktreeManager } from "./worktrees.js";

export const VEX_WORK_MODES = ["auto", "chat", "review", "implement"] as const;

export type VexWorkMode = (typeof VEX_WORK_MODES)[number];
export type ResolvedWorkMode = Exclude<VexWorkMode, "auto">;

export interface ModeDecision {
  mode: ResolvedWorkMode;
  confidence: number;
  source: "override" | "heuristic" | "model" | "fallback";
  reason: string;
}

export interface TechnicalReviewFinding {
  priority: 0 | 1 | 2 | 3;
  title: string;
  explanation: string;
  category?: string;
  file?: string;
  line?: number;
}

export interface TechnicalReviewReport {
  id: string;
  task: string;
  root: string;
  summary: string;
  findings: TechnicalReviewFinding[];
  recommendations: string[];
  provider: string;
  model: string;
  artifactPath: string;
}

export interface NativeConversationClientOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: ConversationFetchLike;
  auth?: ProviderAuthResolver;
}

export type ConversationFetchLike = ProviderFetchLike;

export interface VexModeServiceDependencies {
  roles: Map<ModelRole, RoleDefinition>;
  runner: RoleRunner;
  config: Pick<VexConfigLoader, "resolve">;
  worktrees: Pick<WorktreeManager, "inspectWorkspace">;
  auth?: ProviderAuthResolver;
  conversation?: NativeConversationClient;
  homeDirectory?: string;
}

const CHAT_SYSTEM_PROMPT = `You are VEX Chat, a conversational technical assistant.
Answer the user directly and naturally. You have no repository, filesystem, shell, or editing tools in this mode. Never claim that you inspected or changed local files. If repository evidence is required, explain that the user can switch to review or implement mode. Match the user's language.`;

const MODE_CLASSIFIER_PROMPT = `Classify the user's intended VEX work mode.

- chat: conversation, explanations, conceptual questions, brainstorming, or advice that does not require inspecting the local workspace.
- review: inspect or analyze the current workspace and report architecture, quality, correctness, security, risks, or recommendations without changing files.
- implement: create, fix, refactor, migrate, test, or otherwise change the workspace.

Safety rules:
- Requests saying not to modify files, review only, analyze only, or read-only are always review.
- If inspection is requested without an explicit change, use review.
- If the user explicitly asks to change or implement something, use implement even if analysis is also mentioned.

Return only JSON in this shape:
{"mode":"chat|review|implement","confidence":0.0,"reason":"short reason"}`;

const TECHNICAL_REVIEW_PROMPT = `You are VEX Technical Reviewer operating in a strictly read-only review mode.
Inspect the current workspace only with read, ls, find, and grep. You cannot execute commands, edit files, create commits, or delegate work.

Review the user's requested scope using concrete repository evidence. Focus on architecture, correctness, maintainability, interface contracts, failure handling, security boundaries, and missing tests. Do not propose changes as if they were already implemented. Do not create an execution manifest and do not require a Git diff.

Finish exactly once with team_yield using role "reviewer", status "completed", a concise summary, and this payload:
{
  "summary": "overall assessment",
  "findings": [
    {
      "priority": 0,
      "title": "finding title",
      "explanation": "evidence, impact, and recommended direction",
      "category": "correctness|architecture|security|testing|maintainability",
      "file": "optional/path",
      "line": 1
    }
  ],
  "recommendations": ["ordered next step"]
}
Priority is 0 critical through 3 low. Omit file and line when there is no precise location. Match the user's language.`;

const READ_ONLY_REVIEW_TOOLS = new Set(["read", "ls", "find", "grep", "team_yield"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function clampConfidence(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : fallback;
}

function patternCount(value: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((score, pattern) => score + (pattern.test(value) ? 1 : 0), 0);
}

export function classifyWorkMode(input: string): ModeDecision {
  const text = input.trim().toLowerCase();
  if (!text) {
    return {
      mode: "chat",
      confidence: 1,
      source: "heuristic",
      reason: "empty input is non-mutating",
    };
  }

  const readOnlyOverride = [
    /(?:只|仅).{0,8}(?:评审|审查|检查|分析|评价|建议)/,
    /(?:不要|无需|不用|禁止).{0,10}(?:修改|改动|实现|写代码|提交)/,
    /(?:不修改|不改动|不写代码|只读)/,
    /\b(?:review|audit|analy[sz]e|inspect)\s+only\b/,
    /\bread[- ]only\b/,
    /\b(?:without|do not|don't)\s+(?:making\s+)?(?:changes?|modif|edit|implement)/,
  ].some((pattern) => pattern.test(text));
  if (readOnlyOverride) {
    return {
      mode: "review",
      confidence: 0.99,
      source: "heuristic",
      reason: "the request explicitly requires read-only analysis",
    };
  }

  if (
    /^(?:你好|您好|嗨|哈喽|hello|hi|hey|谢谢|thanks)[!！,.，。\s]*$/i.test(text)
  ) {
    return {
      mode: "chat",
      confidence: 0.99,
      source: "heuristic",
      reason: "the input is conversational",
    };
  }

  const implementationPatterns = [
    /(?:请|帮我|直接|开始|继续|需要|把|将).{0,16}(?:实现|修复|修改|改造|重构|新增|添加|删除|升级|迁移|开发|补充|完成|接入|支持)/,
    /^(?:实现|修复|修改|改造|重构|新增|添加|删除|升级|迁移|开发|补充|完成|接入).{0,18}(?:功能|代码|文件|接口|页面|测试|项目|模块|支持|逻辑|问题|bug)/,
    /(?:并|然后|同时|以及).{0,6}(?:实现|修复|修改|重构|新增|添加|删除|补充)/,
    /(?:^|\bplease\s+|\bcan you\s+|\bcould you\s+|\bi need you to\s+)(?:implement|fix|refactor|add|remove|update|build|create|migrate|rewrite|change)\b/,
    /\b(?:and|then|also)\s+(?:implement|fix|refactor|add|remove|update|build|create|migrate|rewrite|change)\b/,
    /\b(?:write|modify)\s+(?:the\s+)?(?:code|files?|tests?|implementation)\b/,
  ];
  const reviewPatterns = [
    /(?:技术|代码|架构|安全|性能|质量).{0,8}(?:评审|审查|检查|分析|评估)/,
    /(?:评审|审查|检查|分析|评估).{0,12}(?:代码|项目|仓库|架构|实现|风险|问题|设计)/,
    /(?:找出|排查|识别).{0,10}(?:问题|风险|缺陷|漏洞|bug)/,
    /(?:看看|看一下).{0,10}(?:代码|项目|仓库|实现|架构)/,
    /\b(?:review|audit|inspect|assess)\b.{0,30}\b(?:code|repo|repository|codebase|architecture|security|design)\b/,
    /\b(?:code|architecture|security|design)\s+review\b/,
    /\btake a look at\b.{0,30}\b(?:code|repo|repository|codebase|project)\b/,
  ];
  const questionPatterns = [
    /^(?:什么|为什么|为何|如何|怎么|怎样|请解释|解释一下|介绍一下|聊聊|讨论一下)/,
    /[?？]\s*$/,
    /^(?:what|why|how|when|where|who|explain|describe|tell me|compare)\b/,
  ];
  const workspacePatterns = [
    /(?:这个|当前|本地|现有).{0,8}(?:项目|仓库|代码库|代码|实现|架构)/,
    /\b(?:this|current|local)\s+(?:repo|repository|codebase|project|implementation)\b/,
  ];

  const implementationScore = patternCount(text, implementationPatterns) * 4;
  const reviewScore = patternCount(text, reviewPatterns) * 4 +
    patternCount(text, workspacePatterns) * 4;
  const questionScore = patternCount(text, questionPatterns) * 3;

  if (implementationScore >= 4 && implementationScore >= reviewScore) {
    return {
      mode: "implement",
      confidence: Math.min(0.98, 0.86 + implementationScore * 0.02),
      source: "heuristic",
      reason: "the request explicitly asks for workspace changes",
    };
  }
  if (reviewScore >= 4 && reviewScore >= implementationScore) {
    return {
      mode: "review",
      confidence: Math.min(0.97, 0.82 + reviewScore * 0.02),
      source: "heuristic",
      reason: "the request asks to inspect the current workspace",
    };
  }
  if (questionScore >= 3) {
    return {
      mode: "chat",
      confidence: Math.min(0.94, 0.82 + questionScore * 0.02),
      source: "heuristic",
      reason: "the request is an explanatory question",
    };
  }
  return {
    mode: "chat",
    confidence: 0.55,
    source: "heuristic",
    reason: "no clear request to inspect or modify the workspace",
  };
}

export class NativeConversationClient {
  readonly #environment: NodeJS.ProcessEnv;
  readonly #fetch: ConversationFetchLike;
  readonly #auth?: NativeConversationClientOptions["auth"];
  readonly #histories = new Map<string, ProviderMessage[]>();

  constructor(options: NativeConversationClientOptions = {}) {
    this.#environment = options.environment ?? process.env;
    this.#fetch = options.fetch ?? vexFetch;
    this.#auth = options.auth;
  }

  clear(): void {
    this.#histories.clear();
  }

  async chat(
    sessionKey: string,
    input: string,
    provider: ProviderRuntimeConfig,
    runtime: RoleRuntimeConfig,
    signal?: AbortSignal,
  ): Promise<string> {
    const key = `${sessionKey}:${provider.id}:${runtime.model}`;
    const messages = this.#histories.get(key) ?? [
      { role: "system", content: CHAT_SYSTEM_PROMPT } as ProviderMessage,
    ];
    messages.push({ role: "user", content: input });
    if (messages.length > 42) {
      const system = messages[0]!;
      const tail = messages.slice(-40);
      while (tail[0]?.role === "assistant") tail.shift();
      messages.splice(0, messages.length, system, ...tail);
    }
    try {
      const completion = await this.#complete(
        messages,
        provider,
        runtime,
        signal,
        createHash("sha256").update(key).digest("hex").slice(0, 32),
      );
      const reply = completion.content.trim();
      if (!reply) throw new Error("Provider response has no assistant text");
      messages.push({
        role: "assistant",
        content: reply,
        ...(completion.responseItems
          ? { response_items: completion.responseItems }
          : {}),
      });
      this.#histories.set(key, messages);
      return reply;
    } catch (error) {
      messages.pop();
      throw error;
    }
  }

  async classify(
    input: string,
    provider: ProviderRuntimeConfig,
    runtime: RoleRuntimeConfig,
    signal?: AbortSignal,
  ): Promise<ModeDecision> {
    const completion = await this.#complete(
      [
        { role: "system", content: MODE_CLASSIFIER_PROMPT },
        { role: "user", content: input },
      ],
      provider,
      { ...runtime, thinking: "off" },
      signal,
      "vex-mode-classifier",
    );
    const content = completion.content.trim();
    if (!content) throw new Error("Mode classifier returned no text");
    const json = content.match(/\{[\s\S]*\}/)?.[0];
    if (!json) throw new Error("Mode classifier returned no JSON object");
    const parsed = JSON.parse(json) as unknown;
    if (!isRecord(parsed) || !["chat", "review", "implement"].includes(String(parsed.mode))) {
      throw new Error("Mode classifier returned an invalid mode");
    }
    return {
      mode: parsed.mode as ResolvedWorkMode,
      confidence: clampConfidence(parsed.confidence, 0.75),
      source: "model",
      reason: typeof parsed.reason === "string"
        ? parsed.reason.slice(0, 200)
        : "model semantic classification",
    };
  }

  async #complete(
    messages: ProviderMessage[],
    provider: ProviderRuntimeConfig,
    runtime: RoleRuntimeConfig,
    signal?: AbortSignal,
    sessionId?: string,
  ): Promise<ProviderCompletion> {
    return completeProvider({
      provider,
      model: runtime.model,
      thinking: runtime.thinking,
      messages,
      environment: this.#environment,
      fetch: this.#fetch,
      ...(this.#auth ? { auth: this.#auth } : {}),
      ...(signal ? { signal } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
  }
}

function requireRole(
  roles: Map<ModelRole, RoleDefinition>,
  role: ModelRole,
): RoleDefinition {
  const definition = roles.get(role);
  if (!definition) throw new Error(`Fixed role is not loaded: ${role}`);
  return definition;
}

function readOnlyRole(
  definition: RoleDefinition,
  systemPrompt = definition.systemPrompt,
): RoleDefinition {
  return {
    ...definition,
    writes: false,
    tools: definition.tools.filter((tool) => READ_ONLY_REVIEW_TOOLS.has(tool)),
    systemPrompt,
    filePath: "builtin:vex-review-mode",
  };
}

function normalizeScout(result: RoleRunResult): ScoutReport {
  const payload = isRecord(result.yield.payload) ? result.yield.payload : {};
  const strings = (value: unknown) =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  return {
    repositorySummary: typeof payload.repositorySummary === "string"
      ? payload.repositorySummary
      : result.yield.summary,
    relevantPaths: strings(payload.relevantPaths),
    constraints: strings(payload.constraints),
    risks: strings(payload.risks),
  };
}

function priority(value: unknown): 0 | 1 | 2 | 3 {
  if (value === 0 || value === 1 || value === 2 || value === 3) return value;
  if (value === "critical") return 0;
  if (value === "high") return 1;
  if (value === "medium") return 2;
  return 3;
}

function normalizeTechnicalReview(
  result: RoleRunResult,
): Pick<TechnicalReviewReport, "summary" | "findings" | "recommendations"> {
  const payload = isRecord(result.yield.payload) ? result.yield.payload : {};
  const findings = Array.isArray(payload.findings)
    ? payload.findings.flatMap((raw): TechnicalReviewFinding[] => {
        if (!isRecord(raw) || typeof raw.title !== "string") return [];
        const explanation = typeof raw.explanation === "string"
          ? raw.explanation
          : typeof raw.description === "string"
            ? raw.description
            : "No explanation supplied.";
        return [{
          priority: priority(raw.priority),
          title: raw.title,
          explanation,
          ...(typeof raw.category === "string" ? { category: raw.category } : {}),
          ...(typeof raw.file === "string" ? { file: raw.file } : {}),
          ...(typeof raw.line === "number" && Number.isInteger(raw.line) && raw.line > 0
            ? { line: raw.line }
            : {}),
        }];
      })
    : [];
  return {
    summary: typeof payload.summary === "string"
      ? payload.summary
      : result.yield.summary,
    findings: findings.sort((left, right) => left.priority - right.priority),
    recommendations: Array.isArray(payload.recommendations)
      ? payload.recommendations.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  };
}

function successful(result: RoleRunResult): boolean {
  return result.exitCode === 0 &&
    (result.yield.status === "completed" || result.yield.status === "skipped");
}

function reviewId(now = new Date()): string {
  return `review-${now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")}-${randomUUID().slice(0, 8)}`;
}

async function writeJsonAtomic(target: string, value: unknown): Promise<void> {
  const temporary = `${target}.tmp`;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

function routeFor(
  configuration: ResolvedVexConfig,
  role: ModelRole,
): { runtime: RoleRuntimeConfig; provider: ProviderRuntimeConfig } {
  const runtime = configuration.agents[role];
  const provider = configuration.providers[runtime.provider];
  if (!provider) throw new Error(`Unknown Provider ${runtime.provider} for ${role}`);
  return { runtime, provider };
}

export class VexModeService {
  readonly #deps: VexModeServiceDependencies;
  readonly #conversation: NativeConversationClient;
  readonly #homeDirectory: string;
  readonly #lastModes = new Map<string, ResolvedWorkMode>();

  constructor(dependencies: VexModeServiceDependencies) {
    this.#deps = dependencies;
    this.#conversation = dependencies.conversation ??
      new NativeConversationClient({
        ...(dependencies.auth ? { auth: dependencies.auth } : {}),
      });
    this.#homeDirectory = dependencies.homeDirectory ?? os.homedir();
  }

  clearChat(): void {
    this.#conversation.clear();
  }

  async decide(
    cwd: string,
    input: string,
    selectedMode: VexWorkMode,
    options: VexRunOptions = {},
    signal?: AbortSignal,
  ): Promise<ModeDecision> {
    const sessionKey = path.resolve(cwd).toLowerCase();
    const remember = (decision: ModeDecision): ModeDecision => {
      this.#lastModes.set(sessionKey, decision.mode);
      return decision;
    };
    if (selectedMode !== "auto") {
      return remember({
        mode: selectedMode,
        confidence: 1,
        source: "override",
        reason: `session mode is ${selectedMode}`,
      });
    }
    const previousMode = this.#lastModes.get(sessionKey);
    if (
      previousMode &&
      /^(?:继续|接着|往下|按这个做|照此进行|开始吧|执行吧|continue|go ahead|proceed|do it)[!！。\s]*$/i.test(
        input.trim(),
      )
    ) {
      return remember({
        mode: previousMode,
        confidence: 0.92,
        source: "heuristic",
        reason: `continuation of the previous ${previousMode} turn`,
      });
    }
    const heuristic = classifyWorkMode(input);
    if (heuristic.confidence >= 0.8) return remember(heuristic);
    try {
      const { configuration } = await this.#resolve(cwd, options);
      const route = routeFor(configuration, "architect");
      return remember(await this.#conversation.classify(
        previousMode
          ? `Previous resolved mode: ${previousMode}\nCurrent user input: ${input}`
          : input,
        route.provider,
        route.runtime,
        signal,
      ));
    } catch {
      return remember({
        ...heuristic,
        source: "fallback",
        reason: `${heuristic.reason}; semantic model unavailable`,
      });
    }
  }

  async chat(
    cwd: string,
    input: string,
    options: VexRunOptions = {},
    signal?: AbortSignal,
  ): Promise<string> {
    const { root, configuration } = await this.#resolve(cwd, options);
    const route = routeFor(configuration, "architect");
    return this.#conversation.chat(
      root,
      input,
      route.provider,
      route.runtime,
      signal,
    );
  }

  async review(
    cwd: string,
    task: string,
    options: VexRunOptions = {},
    signal?: AbortSignal,
  ): Promise<TechnicalReviewReport> {
    const { root, configuration } = await this.#resolve(cwd, options);
    const id = reviewId();
    const workspaceKey = createHash("sha256")
      .update(root.toLowerCase())
      .digest("hex")
      .slice(0, 16);
    const runDirectory = path.join(
      this.#homeDirectory,
      ".vex",
      "reviews",
      workspaceKey,
      id,
    );
    await mkdir(runDirectory, { recursive: true });

    const scoutDefinition = readOnlyRole(requireRole(this.#deps.roles, "scout"));
    const scoutRoute = routeFor(configuration, "scout");
    const scout = await this.#deps.runner.run(
      {
        runId: id,
        role: scoutDefinition,
        task,
        cwd: root,
        context: {
          runDirectory,
          mode: "technical-review",
          constraint: "Read-only repository discovery; do not execute commands.",
        },
        knowledge: [],
        runtime: scoutRoute.runtime,
        provider: scoutRoute.provider,
      },
      signal,
    );
    await writeJsonAtomic(path.join(runDirectory, "scout-result.json"), scout.yield);
    await writeFile(path.join(runDirectory, "scout-log.jsonl"), scout.rawOutput, "utf8");
    if (!successful(scout)) {
      throw new Error(`Technical review scout failed: ${scout.stderr || scout.yield.summary}`);
    }

    const reviewerDefinition = readOnlyRole(
      requireRole(this.#deps.roles, "reviewer"),
      TECHNICAL_REVIEW_PROMPT,
    );
    const reviewerRoute = routeFor(configuration, "reviewer");
    const reviewer = await this.#deps.runner.run(
      {
        runId: id,
        role: reviewerDefinition,
        task,
        cwd: root,
        context: {
          runDirectory,
          mode: "technical-review",
          scout: normalizeScout(scout),
          constraint:
            "Report evidence and recommendations only. Do not modify the workspace.",
        },
        knowledge: [],
        runtime: reviewerRoute.runtime,
        provider: reviewerRoute.provider,
      },
      signal,
    );
    await writeJsonAtomic(
      path.join(runDirectory, "reviewer-result.json"),
      reviewer.yield,
    );
    await writeFile(
      path.join(runDirectory, "reviewer-log.jsonl"),
      reviewer.rawOutput,
      "utf8",
    );
    if (!successful(reviewer)) {
      throw new Error(
        `Technical reviewer failed: ${reviewer.stderr || reviewer.yield.summary}`,
      );
    }

    const normalized = normalizeTechnicalReview(reviewer);
    const artifactPath = path.join(runDirectory, "technical-review.json");
    const report: TechnicalReviewReport = {
      id,
      task,
      root,
      ...normalized,
      provider: reviewerRoute.provider.id,
      model: reviewerRoute.runtime.model,
      artifactPath,
    };
    await writeJsonAtomic(artifactPath, report);
    return report;
  }

  async #resolve(
    cwd: string,
    options: VexRunOptions,
  ): Promise<{ root: string; configuration: ResolvedVexConfig }> {
    const workspace = await this.#deps.worktrees.inspectWorkspace(cwd);
    const configuration = await this.#deps.config.resolve(
      workspace.root,
      options.model,
      options.projectTrusted ?? false,
      {
        ...(options.provider ? { provider: options.provider } : {}),
        ...(options.roleRoutes ? { roleRoutes: options.roleRoutes } : {}),
      },
    );
    return { root: workspace.root, configuration };
  }
}

export function formatTechnicalReview(report: TechnicalReviewReport): string {
  const findings = report.findings.length > 0
    ? report.findings.map((finding) => {
        const location = finding.file
          ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
          : "";
        const category = finding.category ? ` [${finding.category}]` : "";
        return `- P${finding.priority}${category} ${finding.title}${location}\n  ${finding.explanation}`;
      }).join("\n")
    : "- No actionable findings.";
  const recommendations = report.recommendations.length > 0
    ? report.recommendations.map((item) => `- ${item}`).join("\n")
    : "- None.";
  return `Technical review ${report.id}\n${report.summary}\n\nFindings:\n${findings}\n\nRecommendations:\n${recommendations}\n\nRead-only review: no workspace files were changed.\nArtifact: ${report.artifactPath}`;
}
