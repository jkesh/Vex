import { describe, expect, test } from "bun:test";
import {
  completeProvider,
  discoverProviderModels,
  listProviderModels,
} from "../src/provider-transport.js";
import type { ProviderRuntimeConfig } from "../src/types.js";

const provider: ProviderRuntimeConfig = {
  id: "openai",
  protocol: "openai-chat-completions",
  modelCatalog: "openai",
  baseUrl: "https://api.openai.com/v1",
  apiKeyEnv: "OPENAI_FIXTURE_KEY",
  requiresAuth: true,
  headersEnv: {},
  sendReasoningEffort: false,
  timeoutMs: 10_000,
  maxAgentTurns: 10,
};

const oauth = {
  async getAuthorization() {
    return {
      type: "oauth" as const,
      token: "oauth-access",
      accountId: "account-42",
    };
  },
};

const anthropicProvider: ProviderRuntimeConfig = {
  id: "anthropic",
  protocol: "anthropic-messages",
  modelCatalog: "anthropic",
  baseUrl: "https://api.anthropic.com/v1",
  apiKeyEnv: "ANTHROPIC_FIXTURE_KEY",
  requiresAuth: true,
  headersEnv: {},
  sendReasoningEffort: false,
  timeoutMs: 10_000,
  maxAgentTurns: 10,
};

describe("Provider wire transport", () => {
  test("routes OpenAI OAuth through the ChatGPT Responses backend", async () => {
    let request: Record<string, unknown> | undefined;
    const completion = await completeProvider({
      provider,
      model: "gpt-codex-fixture",
      thinking: "high",
      messages: [
        { role: "system", content: "VEX system" },
        { role: "user", content: "Inspect README" },
      ],
      tools: [{
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: { type: "object" },
        },
      }],
      auth: oauth,
      environment: {},
      sessionId: "run-42",
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          "https://chatgpt.com/backend-api/codex/responses",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer oauth-access");
        expect(headers.get("chatgpt-account-id")).toBe("account-42");
        expect(headers.get("originator")).toBe("vex");
        expect(headers.get("session-id")).toBe("run-42");
        expect(headers.get("user-agent")).toContain("vex/0.8.2");
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const output = [
          {
            id: "reasoning-1",
            type: "reasoning",
            encrypted_content: "opaque-reasoning",
          },
          {
            id: "function-1",
            type: "function_call",
            call_id: "call-1",
            name: "read",
            arguments: "{\"path\":\"README.md\"}",
          },
          {
            id: "message-1",
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "I will inspect it." }],
          },
        ];
        return new Response(
          `data: ${JSON.stringify({
            type: "response.completed",
            response: {
              output,
              usage: {
                input_tokens: 120,
                output_tokens: 30,
                total_tokens: 150,
                input_tokens_details: { cached_tokens: 40 },
                output_tokens_details: { reasoning_tokens: 12 },
              },
            },
          })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });

    expect(request).toMatchObject({
      model: "gpt-codex-fixture",
      instructions: "VEX system",
      store: false,
      stream: true,
      tool_choice: "auto",
      parallel_tool_calls: true,
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(request?.tools).toEqual([
      expect.objectContaining({ type: "function", name: "read", strict: false }),
    ]);
    expect(JSON.stringify(request?.input)).toContain("Inspect README");
    expect(completion.content).toBe("I will inspect it.");
    expect(completion.toolCalls).toEqual([{
      id: "call-1",
      type: "function",
      function: { name: "read", arguments: "{\"path\":\"README.md\"}" },
    }]);
    expect(JSON.stringify(completion.responseItems)).toContain(
      "opaque-reasoning",
    );
    expect(completion.usage).toEqual({
      inputTokens: 120,
      outputTokens: 30,
      cachedInputTokens: 40,
      reasoningTokens: 12,
      totalTokens: 150,
    });
  });

  test("loads the OAuth model catalog from the Codex backend", async () => {
    const models = await listProviderModels({
      provider,
      auth: oauth,
      environment: {},
      fetch: async (input, init) => {
        expect(String(input)).toBe(
          "https://chatgpt.com/backend-api/codex/models?client_version=1.0.0",
        );
        const headers = new Headers(init?.headers);
        expect(headers.get("chatgpt-account-id")).toBe("account-42");
        return new Response(JSON.stringify({
          models: [
            { slug: "gpt-visible", visibility: "list" },
            { slug: "gpt-hidden", visibility: "hide" },
          ],
        }), { status: 200 });
      },
    });
    expect(models).toEqual(["gpt-visible"]);
  });

  test("keeps API-key Providers on Chat Completions", async () => {
    const completion = await completeProvider({
      provider,
      model: "gpt-api-fixture",
      thinking: "off",
      messages: [{ role: "user", content: "hello" }],
      auth: { async getApiKey() { return "api-secret"; } },
      environment: {},
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://api.openai.com/v1/chat/completions");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer api-secret",
        );
        return new Response(JSON.stringify({
          choices: [{ message: { content: "hello back" } }],
          usage: {
            prompt_tokens: 20,
            completion_tokens: 5,
            total_tokens: 25,
            prompt_cache_hit_tokens: 8,
            completion_tokens_details: { reasoning_tokens: 2 },
          },
        }), { status: 200 });
      },
    });
    expect(completion).toEqual({
      content: "hello back",
      toolCalls: [],
      usage: {
        inputTokens: 20,
        outputTokens: 5,
        cachedInputTokens: 8,
        reasoningTokens: 2,
        totalTokens: 25,
      },
    });
  });

  test("uses native Anthropic Messages with tool-use round trips", async () => {
    let request: Record<string, unknown> | undefined;
    const completion = await completeProvider({
      provider: anthropicProvider,
      model: "claude-fixture",
      thinking: "high",
      messages: [
        { role: "system", content: "VEX system" },
        { role: "user", content: "Inspect README" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-read",
            type: "function",
            function: { name: "read", arguments: '{"path":"README.md"}' },
          }],
        },
        {
          role: "tool",
          content: "README contents",
          tool_call_id: "call-read",
        },
      ],
      tools: [{
        type: "function",
        function: {
          name: "read",
          description: "Read a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
      }],
      environment: { ANTHROPIC_FIXTURE_KEY: "anthropic-secret" },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://api.anthropic.com/v1/messages");
        const headers = new Headers(init?.headers);
        expect(headers.get("x-api-key")).toBe("anthropic-secret");
        expect(headers.get("authorization")).toBeNull();
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          content: [
            { type: "text", text: "I inspected it." },
            {
              type: "tool_use",
              id: "call-write",
              name: "write",
              input: { path: "notes.md", content: "done" },
            },
          ],
          usage: {
            input_tokens: 70,
            output_tokens: 20,
            cache_creation_input_tokens: 10,
            cache_read_input_tokens: 30,
          },
        }), { status: 200 });
      },
    });

    expect(request).toMatchObject({
      model: "claude-fixture",
      max_tokens: 8192,
      system: "VEX system",
      tool_choice: { type: "auto" },
      tools: [{
        name: "read",
        description: "Read a file",
        input_schema: expect.objectContaining({ type: "object" }),
      }],
    });
    expect(JSON.stringify(request?.messages)).toContain("tool_result");
    expect(completion.content).toBe("I inspected it.");
    expect(completion.toolCalls).toEqual([{
      id: "call-write",
      type: "function",
      function: {
        name: "write",
        arguments: '{"path":"notes.md","content":"done"}',
      },
    }]);
    expect(completion.responseItems).toHaveLength(2);
    expect(completion.usage).toEqual({
      inputTokens: 110,
      outputTokens: 20,
      cachedInputTokens: 30,
      reasoningTokens: 0,
      totalTokens: 130,
    });
  });

  test("paginates the Anthropic model catalog and preserves model hints", async () => {
    const requested: string[] = [];
    const catalog = await discoverProviderModels({
      provider: anthropicProvider,
      environment: { ANTHROPIC_FIXTURE_KEY: "anthropic-secret" },
      fetch: async (input) => {
        requested.push(String(input));
        const secondPage = String(input).includes("after_id=claude-b");
        return new Response(JSON.stringify(secondPage
          ? {
              data: [{
                id: "claude-a",
                display_name: "Claude A",
                created_at: "2026-01-01T00:00:00Z",
                max_input_tokens: 200000,
                max_tokens: 32000,
                capabilities: { citations: { supported: true } },
              }],
              has_more: false,
              last_id: "claude-a",
            }
          : {
              data: [{ id: "claude-b", display_name: "Claude B" }],
              has_more: true,
              last_id: "claude-b",
            }), { status: 200 });
      },
    });

    expect(requested).toEqual([
      "https://api.anthropic.com/v1/models?limit=1000",
      "https://api.anthropic.com/v1/models?limit=1000&after_id=claude-b",
    ]);
    expect(catalog.catalogProtocol).toBe("anthropic");
    expect(catalog.models.map((model) => model.id)).toEqual([
      "claude-a",
      "claude-b",
    ]);
    expect(catalog.models[0]).toMatchObject({
      displayName: "Claude A",
      maxInputTokens: 200000,
      maxOutputTokens: 32000,
      capabilities: ["citations"],
    });
  });

  test("discovers NewAPI and Sub2API through the OpenAI model convention", async () => {
    const gateway: ProviderRuntimeConfig = {
      ...provider,
      id: "newapi",
      baseUrl: "https://gateway.example/v1",
      apiKeyEnv: "NEWAPI_KEY",
    };
    const catalog = await discoverProviderModels({
      provider: gateway,
      environment: { NEWAPI_KEY: "gateway-secret" },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://gateway.example/v1/models");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer gateway-secret",
        );
        return new Response(JSON.stringify({
          object: "list",
          data: [
            { id: "deepseek-chat", owned_by: "deepseek" },
            { id: "claude-through-gateway", owned_by: "anthropic" },
          ],
        }), { status: 200 });
      },
    });
    expect(catalog.catalogProtocol).toBe("openai");
    expect(catalog.models).toEqual([
      expect.objectContaining({
        id: "claude-through-gateway",
        provider: "newapi",
        ownedBy: "anthropic",
      }),
      expect.objectContaining({
        id: "deepseek-chat",
        provider: "newapi",
        ownedBy: "deepseek",
      }),
    ]);

    const sub2api = await discoverProviderModels({
      provider: {
        ...gateway,
        id: "sub2api",
        protocol: "anthropic-messages",
        modelCatalog: "openai",
        apiKeyEnv: "SUB2API_KEY",
      },
      environment: { SUB2API_KEY: "sub2api-secret" },
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://gateway.example/v1/models");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer sub2api-secret");
        expect(headers.get("x-api-key")).toBeNull();
        return new Response(JSON.stringify({
          data: [{ id: "claude-native" }],
        }), { status: 200 });
      },
    });
    expect(sub2api.models[0]).toMatchObject({
      id: "claude-native",
      provider: "sub2api",
    });
  });
});
