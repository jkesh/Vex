import type { AgentToolDefinition } from "./agent-tools.js";
import type { ProviderAuthorization } from "./auth.js";
import { vexFetch } from "./http-client.js";
import { OPENAI_CODEX_BASE_URL } from "./openai-oauth.js";
import type {
  ProviderRuntimeConfig,
  ThinkingLevel,
} from "./types.js";
import { VEX_VERSION } from "./version.js";

// The Codex catalog treats this query as a schema/client capability floor.
// It is deliberately separate from the VEX package version.
export const OPENAI_CODEX_MODEL_CATALOG_VERSION = "1.0.0";

export type ProviderFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ProviderAuthResolver {
  getAuthorization?(
    provider: string,
  ): Promise<ProviderAuthorization | undefined>;
  getApiKey?(provider: string): Promise<string | undefined>;
}

export interface ProviderToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ProviderToolCall[];
  tool_call_id?: string;
  response_items?: unknown[];
}

export interface ProviderCompletion {
  content: string;
  toolCalls: ProviderToolCall[];
  responseItems?: unknown[];
}

export interface ProviderCompletionInput {
  provider: ProviderRuntimeConfig;
  model: string;
  thinking: ThinkingLevel;
  messages: ProviderMessage[];
  tools?: AgentToolDefinition[];
  auth?: ProviderAuthResolver;
  environment?: NodeJS.ProcessEnv;
  fetch?: ProviderFetchLike;
  signal?: AbortSignal;
  sessionId?: string;
}

export interface ProviderModelListInput {
  provider: ProviderRuntimeConfig;
  auth?: ProviderAuthResolver;
  environment?: NodeJS.ProcessEnv;
  fetch?: ProviderFetchLike;
  signal?: AbortSignal;
}

export type ProviderModelCatalogProtocol =
  | "openai"
  | "anthropic"
  | "openai-codex";

export interface ProviderModel {
  id: string;
  provider: string;
  catalogProtocol: ProviderModelCatalogProtocol;
  displayName?: string;
  description?: string;
  ownedBy?: string;
  createdAt?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  capabilities?: string[];
}

export interface ProviderModelCatalog {
  provider: ProviderRuntimeConfig;
  catalogProtocol: ProviderModelCatalogProtocol;
  endpoint: string;
  models: ProviderModel[];
}

interface ChatCompletionPayload {
  choices?: Array<{
    message?: { content?: unknown; tool_calls?: unknown };
  }>;
  error?: { message?: unknown };
}

interface ResolvedAuthorization {
  authorization?: ProviderAuthorization;
  headers: Record<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function cleanBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part) =>
      isRecord(part) && typeof part.text === "string" ? part.text : ""
    )
    .filter(Boolean)
    .join("\n");
}

function normalizeToolCalls(value: unknown): ProviderToolCall[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    if (!isRecord(item) || !isRecord(item.function)) return [];
    const name = item.function.name;
    const args = item.function.arguments;
    if (typeof name !== "string" || !name) return [];
    return [{
      id: typeof item.id === "string" && item.id
        ? item.id
        : `vex-tool-${index}`,
      type: "function" as const,
      function: {
        name,
        arguments: typeof args === "string"
          ? args
          : JSON.stringify(args ?? {}),
      },
    }];
  });
}

async function resolveAuthorization(
  provider: ProviderRuntimeConfig,
  auth: ProviderAuthResolver | undefined,
  environment: NodeJS.ProcessEnv,
  authorizationStyle: "openai" | "anthropic" =
    provider.protocol === "anthropic-messages" ? "anthropic" : "openai",
): Promise<ResolvedAuthorization> {
  const environmentToken = provider.apiKeyEnv
    ? environment[provider.apiKeyEnv]
    : undefined;
  let authorization: ProviderAuthorization | undefined = environmentToken
    ? { type: "api-key", token: environmentToken }
    : undefined;
  if (!authorization && auth?.getAuthorization) {
    authorization = await auth.getAuthorization(provider.id);
  }
  if (!authorization && auth?.getApiKey) {
    const token = await auth.getApiKey(provider.id);
    if (token) authorization = { type: "api-key", token };
  }
  if (!authorization && provider.requiresAuth) {
    throw new Error(
      `Provider ${provider.id} is not connected. Use /provider ${provider.id}${provider.apiKeyEnv ? ` or set ${provider.apiKeyEnv}` : ""}.`,
    );
  }
  if (authorization?.type === "oauth" && provider.id !== "openai") {
    throw new Error(
      `OAuth credentials are not supported by Provider ${provider.id}. Reconnect it with an API key.`,
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (authorization) {
    if (
      authorizationStyle === "anthropic" &&
      authorization.type === "api-key"
    ) {
      headers["x-api-key"] = authorization.token;
    } else {
      headers.authorization = `Bearer ${authorization.token}`;
    }
  }
  if (authorizationStyle === "anthropic") {
    headers["anthropic-version"] = "2023-06-01";
  }
  for (const [header, environmentName] of Object.entries(provider.headersEnv)) {
    const value = environment[environmentName];
    if (value) headers[header] = value;
  }
  return {
    ...(authorization ? { authorization } : {}),
    headers,
  };
}

async function withRequestTimeout<T>(
  timeoutMs: number,
  signal: AbortSignal | undefined,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("VEX request aborted", "AbortError");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  try {
    return await action(controller.signal);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function responseErrorMessage(payload: unknown, fallback: string): string {
  if (!isRecord(payload)) return fallback;
  const error = payload.error;
  if (typeof error === "string") return error;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  if (isRecord(payload.response) && isRecord(payload.response.error)) {
    const message = payload.response.error.message;
    if (typeof message === "string") return message;
  }
  return fallback;
}

function parseJson(text: string, status: number): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `Provider returned non-JSON HTTP ${status}: ${text.slice(0, 500)}`,
    );
  }
}

function chatCompletion(
  payload: ChatCompletionPayload,
): ProviderCompletion {
  const rawMessage = payload.choices?.[0]?.message;
  if (!rawMessage) throw new Error("Provider response has no assistant message");
  return {
    content: contentText(rawMessage.content),
    toolCalls: normalizeToolCalls(rawMessage.tool_calls),
  };
}

function flatResponseTools(
  tools: readonly AgentToolDefinition[],
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    type: "function",
    name: tool.function.name,
    description: tool.function.description,
    parameters: tool.function.parameters,
    strict: false,
  }));
}

function responseInstructions(messages: readonly ProviderMessage[]): string {
  return messages
    .filter((message) => message.role === "system" && message.content)
    .map((message) => message.content)
    .join("\n\n");
}

function responseInput(messages: readonly ProviderMessage[]): unknown[] {
  return messages.flatMap((message) => {
    if (message.role === "system") return [];
    if (
      message.role === "assistant" &&
      message.response_items &&
      message.response_items.length > 0
    ) {
      return message.response_items;
    }
    if (message.role === "tool") {
      if (!message.tool_call_id) return [];
      return [{
        type: "function_call_output",
        call_id: message.tool_call_id,
        output: message.content ?? "",
      }];
    }
    if (message.role === "user") {
      return [{
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: message.content ?? "" }],
      }];
    }
    const items: unknown[] = [];
    if (message.content) {
      items.push({
        type: "message",
        role: "assistant",
        content: [{
          type: "output_text",
          text: message.content,
          annotations: [],
        }],
      });
    }
    for (const call of message.tool_calls ?? []) {
      items.push({
        type: "function_call",
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      });
    }
    return items;
  });
}

function reasoningFor(thinking: ThinkingLevel): Record<string, string> | undefined {
  if (thinking === "off") return undefined;
  return {
    effort: thinking === "max" ? "xhigh" : thinking,
    summary: "auto",
  };
}

function parseSseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  let data: string[] = [];
  const flush = () => {
    if (data.length === 0) return;
    const value = data.join("\n").trim();
    data = [];
    if (!value || value === "[DONE]") return;
    try {
      events.push(JSON.parse(value) as unknown);
    } catch {
      // Ignore non-JSON SSE keepalive or diagnostic events.
    }
  };
  for (const line of text.split(/\r?\n/)) {
    if (!line) {
      flush();
      continue;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  flush();
  return events;
}

function outputItemsFromEvents(events: readonly unknown[]): unknown[] {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (
      isRecord(event) &&
      event.type === "response.completed" &&
      isRecord(event.response) &&
      Array.isArray(event.response.output)
    ) {
      return event.response.output;
    }
  }
  const indexed = new Map<number, unknown>();
  const unordered: unknown[] = [];
  for (const event of events) {
    if (
      !isRecord(event) ||
      event.type !== "response.output_item.done" ||
      !isRecord(event.item)
    ) continue;
    if (typeof event.output_index === "number") {
      indexed.set(event.output_index, event.item);
    } else {
      unordered.push(event.item);
    }
  }
  return [
    ...[...indexed.entries()].sort(([left], [right]) => left - right)
      .map(([, item]) => item),
    ...unordered,
  ];
}

function completionFromResponseItems(
  items: readonly unknown[],
  fallbackText = "",
): ProviderCompletion {
  const text: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (
          isRecord(part) &&
          (part.type === "output_text" || part.type === "text") &&
          typeof part.text === "string"
        ) text.push(part.text);
      }
      continue;
    }
    if (
      item.type === "function_call" &&
      typeof item.name === "string" &&
      item.name
    ) {
      toolCalls.push({
        id: typeof item.call_id === "string" && item.call_id
          ? item.call_id
          : typeof item.id === "string" && item.id
            ? item.id
            : `vex-tool-${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name,
          arguments: typeof item.arguments === "string"
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }
  return {
    content: text.join("\n").trim() || fallbackText.trim(),
    toolCalls,
    ...(items.length > 0 ? { responseItems: [...items] } : {}),
  };
}

function responsesCompletion(text: string, status: number): ProviderCompletion {
  const trimmed = text.trim();
  const events = trimmed.startsWith("data:") || trimmed.startsWith("event:")
    ? parseSseEvents(text)
    : [parseJson(text, status)];
  for (const event of events) {
    if (!isRecord(event)) continue;
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error(`Provider error: ${responseErrorMessage(event, "Responses request failed")}`);
    }
  }
  const items = outputItemsFromEvents(events);
  let fallbackText = "";
  for (const event of events) {
    if (
      isRecord(event) &&
      event.type === "response.output_text.delta" &&
      typeof event.delta === "string"
    ) fallbackText += event.delta;
  }
  if (items.length === 0 && events.length === 1 && isRecord(events[0])) {
    const payload = events[0];
    if (Array.isArray(payload.output)) items.push(...payload.output);
    if (typeof payload.output_text === "string") fallbackText = payload.output_text;
  }
  return completionFromResponseItems(items, fallbackText);
}

interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

interface AnthropicMessagePayload {
  content?: unknown;
  error?: { message?: unknown };
}

function toolInput(argumentsText: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function anthropicConversation(
  messages: readonly ProviderMessage[],
): { system: string; messages: AnthropicWireMessage[] } {
  const system = messages
    .filter((message) => message.role === "system" && message.content)
    .map((message) => message.content)
    .join("\n\n");
  const wire: AnthropicWireMessage[] = [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    if (message.role === "system") continue;
    if (message.role === "user") {
      wire.push({ role: "user", content: message.content ?? "" });
      continue;
    }
    if (message.role === "tool") {
      const content: Array<Record<string, unknown>> = [];
      for (; index < messages.length; index++) {
        const tool = messages[index]!;
        if (tool.role !== "tool") {
          index--;
          break;
        }
        if (!tool.tool_call_id) continue;
        content.push({
          type: "tool_result",
          tool_use_id: tool.tool_call_id,
          content: tool.content ?? "",
        });
      }
      if (content.length > 0) wire.push({ role: "user", content });
      continue;
    }

    if (message.response_items && message.response_items.length > 0) {
      const content = message.response_items.filter(isRecord);
      if (content.length > 0) wire.push({ role: "assistant", content });
      continue;
    }
    const content: Array<Record<string, unknown>> = [];
    if (message.content) content.push({ type: "text", text: message.content });
    for (const call of message.tool_calls ?? []) {
      content.push({
        type: "tool_use",
        id: call.id,
        name: call.function.name,
        input: toolInput(call.function.arguments),
      });
    }
    if (content.length > 0) wire.push({ role: "assistant", content });
  }
  return { system, messages: wire };
}

function anthropicTools(
  tools: readonly AgentToolDefinition[],
): Array<Record<string, unknown>> {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function anthropicCompletion(
  payload: AnthropicMessagePayload,
): ProviderCompletion {
  if (!Array.isArray(payload.content)) {
    throw new Error("Anthropic response has no content blocks");
  }
  const text: string[] = [];
  const toolCalls: ProviderToolCall[] = [];
  const responseItems: unknown[] = [];
  for (const block of payload.content) {
    if (!isRecord(block)) continue;
    responseItems.push(block);
    if (block.type === "text" && typeof block.text === "string") {
      text.push(block.text);
      continue;
    }
    if (
      block.type === "tool_use" &&
      typeof block.name === "string" &&
      block.name
    ) {
      toolCalls.push({
        id: typeof block.id === "string" && block.id
          ? block.id
          : `vex-tool-${toolCalls.length}`,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }
  return {
    content: text.join("\n").trim(),
    toolCalls,
    ...(responseItems.length > 0 ? { responseItems } : {}),
  };
}

function oauthHeaders(
  base: Record<string, string>,
  authorization: Extract<ProviderAuthorization, { type: "oauth" }>,
  sessionId?: string,
): Record<string, string> {
  return {
    ...base,
    accept: "text/event-stream",
    authorization: `Bearer ${authorization.token}`,
    originator: "vex",
    "user-agent": `vex/${VEX_VERSION}`,
    ...(authorization.accountId
      ? { "ChatGPT-Account-ID": authorization.accountId }
      : {}),
    ...(sessionId ? { "session-id": sessionId } : {}),
  };
}

export async function completeProvider(
  input: ProviderCompletionInput,
): Promise<ProviderCompletion> {
  const environment = input.environment ?? process.env;
  const fetch = input.fetch ?? vexFetch;
  const resolved = await resolveAuthorization(
    input.provider,
    input.auth,
    environment,
  );
  const oauth = resolved.authorization?.type === "oauth"
    ? resolved.authorization
    : undefined;
  const tools = input.tools ?? [];

  if (oauth) {
    const reasoning = reasoningFor(input.thinking);
    const body: Record<string, unknown> = {
      model: input.model,
      instructions: responseInstructions(input.messages),
      input: responseInput(input.messages),
      tools: flatResponseTools(tools),
      tool_choice: "auto",
      parallel_tool_calls: tools.length > 0,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      ...(reasoning ? { reasoning } : {}),
    };
    return withRequestTimeout(
      input.provider.timeoutMs,
      input.signal,
      async (signal) => {
        const response = await fetch(`${OPENAI_CODEX_BASE_URL}/responses`, {
          method: "POST",
          headers: oauthHeaders(resolved.headers, oauth, input.sessionId),
          body: JSON.stringify(body),
          signal,
        });
        const responseText = await response.text();
        if (!response.ok) {
          let payload: unknown;
          try {
            payload = JSON.parse(responseText) as unknown;
          } catch {
            payload = undefined;
          }
          throw new Error(
            `Provider HTTP ${response.status}: ${responseErrorMessage(payload, responseText.slice(0, 500))}`,
          );
        }
        return responsesCompletion(responseText, response.status);
      },
    );
  }

  if (input.provider.protocol === "anthropic-messages") {
    const conversation = anthropicConversation(input.messages);
    const body: Record<string, unknown> = {
      model: input.model,
      max_tokens: 8_192,
      messages: conversation.messages,
      ...(conversation.system ? { system: conversation.system } : {}),
      ...(tools.length > 0
        ? { tools: anthropicTools(tools), tool_choice: { type: "auto" } }
        : {}),
    };
    return withRequestTimeout(
      input.provider.timeoutMs,
      input.signal,
      async (signal) => {
        const response = await fetch(
          `${cleanBaseUrl(input.provider.baseUrl)}/messages`,
          {
            method: "POST",
            headers: resolved.headers,
            body: JSON.stringify(body),
            signal,
          },
        );
        const responseText = await response.text();
        const payload = parseJson(
          responseText,
          response.status,
        ) as AnthropicMessagePayload;
        if (!response.ok) {
          throw new Error(
            `Provider HTTP ${response.status}: ${responseErrorMessage(payload, responseText.slice(0, 500))}`,
          );
        }
        return anthropicCompletion(payload);
      },
    );
  }

  const body: Record<string, unknown> = {
    model: input.model,
    messages: input.messages.map(({ response_items: _responseItems, ...message }) =>
      message
    ),
    ...(tools.length > 0 ? { tools, tool_choice: "auto" } : {}),
  };
  if (
    input.provider.sendReasoningEffort &&
    input.thinking !== "off"
  ) body.reasoning_effort = input.thinking;
  return withRequestTimeout(
    input.provider.timeoutMs,
    input.signal,
    async (signal) => {
      const response = await fetch(
        `${cleanBaseUrl(input.provider.baseUrl)}/chat/completions`,
        {
          method: "POST",
          headers: resolved.headers,
          body: JSON.stringify(body),
          signal,
        },
      );
      const responseText = await response.text();
      const payload = parseJson(responseText, response.status) as ChatCompletionPayload;
      if (!response.ok) {
        throw new Error(
          `Provider HTTP ${response.status}: ${responseErrorMessage(payload, responseText.slice(0, 500))}`,
        );
      }
      return chatCompletion(payload);
    },
  );
}

function modelCreatedAt(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const timestamp = value < 10_000_000_000 ? value * 1_000 : value;
  const date = new Date(timestamp);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}

function modelCapabilities(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    const names = value.filter(
      (entry): entry is string => typeof entry === "string" && Boolean(entry),
    );
    return names.length > 0 ? [...new Set(names)].sort() : undefined;
  }
  if (!isRecord(value)) return undefined;
  const names = Object.entries(value).flatMap(([name, support]) => {
    if (support === true) return [name];
    return isRecord(support) && support.supported === true ? [name] : [];
  });
  return names.length > 0 ? names.sort() : undefined;
}

function inferredModelCapabilities(entry: Record<string, unknown>): string[] {
  const capabilities: string[] = [];
  if (Array.isArray(entry.input_modalities)) {
    capabilities.push(
      ...entry.input_modalities.filter(
        (value): value is string => typeof value === "string" && value !== "text",
      ),
    );
  }
  if (entry.supports_parallel_tool_calls === true) {
    capabilities.push("parallel-tools");
  }
  if (entry.supports_search_tool === true) capabilities.push("search");
  if (
    Array.isArray(entry.supported_reasoning_levels) &&
    entry.supported_reasoning_levels.length > 0
  ) capabilities.push("reasoning");
  return capabilities;
}

function modelDescriptors(
  payload: unknown,
  providerId: string,
  catalogProtocol: ProviderModelCatalogProtocol,
): ProviderModel[] {
  if (!isRecord(payload)) return [];
  const oauth = catalogProtocol === "openai-codex";
  const entries = oauth ? payload.models : payload.data;
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((entry): ProviderModel[] => {
    if (typeof entry === "string" && entry.trim()) {
      return [{
        id: entry.trim(),
        provider: providerId,
        catalogProtocol,
      }];
    }
    if (!isRecord(entry) || (oauth && entry.visibility === "hide")) return [];
    const rawId = oauth ? entry.slug : entry.id;
    if (typeof rawId !== "string" || !rawId.trim()) return [];
    const displayName = oauth ? entry.display_name : entry.display_name ?? entry.name;
    const createdAt = modelCreatedAt(entry.created_at ?? entry.created);
    const capabilities = [
      ...(modelCapabilities(entry.capabilities) ?? []),
      ...inferredModelCapabilities(entry),
    ];
    return [{
      id: rawId.trim(),
      provider: providerId,
      catalogProtocol,
      ...(typeof displayName === "string" && displayName.trim()
        ? { displayName: displayName.trim() }
        : {}),
      ...(typeof entry.description === "string" && entry.description.trim()
        ? { description: entry.description.trim() }
        : {}),
      ...(typeof entry.owned_by === "string" && entry.owned_by.trim()
        ? { ownedBy: entry.owned_by.trim() }
        : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(typeof (entry.max_input_tokens ?? entry.context_window ??
          entry.max_context_window) === "number"
        ? {
            maxInputTokens: (entry.max_input_tokens ?? entry.context_window ??
              entry.max_context_window) as number,
          }
        : {}),
      ...(typeof (entry.max_tokens ?? entry.max_output_tokens) === "number"
        ? { maxOutputTokens: (entry.max_tokens ?? entry.max_output_tokens) as number }
        : {}),
      ...(capabilities.length > 0
        ? { capabilities: [...new Set(capabilities)].sort() }
        : {}),
    }];
  });
}

function uniqueModels(models: readonly ProviderModel[]): ProviderModel[] {
  return [...new Map(models.map((model) => [model.id, model])).values()]
    .sort((left, right) => left.id.localeCompare(right.id));
}

export async function discoverProviderModels(
  input: ProviderModelListInput,
): Promise<ProviderModelCatalog> {
  const environment = input.environment ?? process.env;
  const fetch = input.fetch ?? vexFetch;
  const resolved = await resolveAuthorization(
    input.provider,
    input.auth,
    environment,
    input.provider.modelCatalog,
  );
  const oauth = resolved.authorization?.type === "oauth"
    ? resolved.authorization
    : undefined;
  const catalogProtocol: ProviderModelCatalogProtocol = oauth
    ? "openai-codex"
    : input.provider.modelCatalog;
  const codexCatalogVersion =
    environment.VEX_OPENAI_CODEX_CLIENT_VERSION?.trim() ||
    OPENAI_CODEX_MODEL_CATALOG_VERSION;
  const endpoint = oauth
    ? `${OPENAI_CODEX_BASE_URL}/models?client_version=${encodeURIComponent(codexCatalogVersion)}`
    : `${cleanBaseUrl(input.provider.baseUrl)}/models`;
  return withRequestTimeout(
    Math.min(30_000, input.provider.timeoutMs),
    input.signal,
    async (signal) => {
      const models: ProviderModel[] = [];
      let afterId: string | undefined;
      for (let page = 0; page < 20; page++) {
        const pageUrl = catalogProtocol === "anthropic"
          ? new URL(endpoint)
          : undefined;
        if (pageUrl) {
          pageUrl.searchParams.set("limit", "1000");
          if (afterId) pageUrl.searchParams.set("after_id", afterId);
        }
        const response = await fetch(pageUrl ?? endpoint, {
          headers: oauth
            ? { ...oauthHeaders(resolved.headers, oauth), accept: "application/json" }
            : resolved.headers,
          signal,
        });
        const responseText = await response.text();
        const payload = parseJson(responseText, response.status);
        if (!response.ok) {
          throw new Error(
            `${input.provider.id} model listing failed (${response.status}): ${responseErrorMessage(payload, responseText.slice(0, 1_000))}`,
          );
        }
        models.push(
          ...modelDescriptors(payload, input.provider.id, catalogProtocol),
        );
        if (
          catalogProtocol !== "anthropic" ||
          !isRecord(payload) ||
          payload.has_more !== true
        ) break;
        if (typeof payload.last_id !== "string" || !payload.last_id) {
          throw new Error(
            `${input.provider.id} model listing returned has_more without last_id`,
          );
        }
        if (payload.last_id === afterId) {
          throw new Error(
            `${input.provider.id} model listing repeated pagination cursor ${afterId}`,
          );
        }
        afterId = payload.last_id;
      }
      return {
        provider: input.provider,
        catalogProtocol,
        endpoint,
        models: uniqueModels(models),
      };
    },
  );
}

export async function listProviderModels(
  input: ProviderModelListInput,
): Promise<string[]> {
  return (await discoverProviderModels(input)).models.map((model) => model.id);
}
