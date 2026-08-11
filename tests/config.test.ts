import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VexConfigLoader } from "../src/config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ home: string; root: string }> {
  const home = await mkdtemp(path.join(os.tmpdir(), "vex-config-"));
  temporaryDirectories.push(home);
  const root = path.join(home, "work", "repo");
  await mkdir(root, { recursive: true });
  return { home, root };
}

describe("independent VEX configuration", () => {
  test("layers user and trusted project config without external tool formats", async () => {
    const { home, root } = await fixture();
    await mkdir(path.join(home, ".vex"), { recursive: true });
    await writeFile(
      path.join(home, ".vex", "config.jsonc"),
      `{
        "defaultModel": "openai/default",
        "provider": {
          "baseUrl": "https://models.example/v1",
          "apiKeyEnv": "COMPANY_MODEL_KEY"
        },
        "agents": { "architect": { "model": "openai/planner", "thinking": "xhigh" } }
      }`,
      "utf8",
    );
    await mkdir(path.join(root, ".vex"), { recursive: true });
    await writeFile(
      path.join(root, ".vex", "config.yaml"),
      [
        "maxParallelWriters: 1",
        "maxRepairAttempts: 3",
        "projectCommands:",
        "  - npm test",
        "agents:",
        "  backend:",
        "    model: company/backend",
      ].join("\n"),
      "utf8",
    );
    const config = await new VexConfigLoader({
      homeDirectory: home,
      environment: {},
    }).resolve(root, undefined, true);
    expect(config.provider.baseUrl).toBe("https://models.example/v1");
    expect(config.provider.apiKeyEnv).toBe("COMPANY_MODEL_KEY");
    expect(config.agents.architect.model).toBe("openai/planner");
    expect(config.agents.architect.thinking).toBe("xhigh");
    expect(config.agents.backend.model).toBe("company/backend");
    expect(config.agents.frontend.model).toBe("openai/default");
    expect(config.maxParallelWriters).toBe(1);
    expect(config.maxRepairAttempts).toBe(3);
    expect(config.projectCommands).toEqual(["npm test"]);
    expect(config.sources.every((source) => !/\.omp|\.omo|\.pi/.test(source))).toBe(true);
  });

  test("ignores repository config until explicitly trusted", async () => {
    const { home, root } = await fixture();
    await mkdir(path.join(home, ".vex"), { recursive: true });
    await writeFile(
      path.join(home, ".vex", "config.json"),
      '{ "defaultModel": "safe/model" }',
      "utf8",
    );
    await mkdir(path.join(root, ".vex"), { recursive: true });
    await writeFile(
      path.join(root, ".vex", "config.json"),
      '{ "defaultModel": "project/model", "provider": { "baseUrl": "https://untrusted.invalid/v1" }, "projectCommands": ["npm test"] }',
      "utf8",
    );
    const config = await new VexConfigLoader({
      homeDirectory: home,
      environment: {},
    }).resolve(root, undefined, false);
    expect(config.agents.backend.model).toBe("safe/model");
    expect(config.provider.baseUrl).toBe("https://api.openai.com/v1");
    expect(config.projectCommands).toEqual([]);
  });

  test("supports explicit environment and command model overrides", async () => {
    const { home, root } = await fixture();
    const loader = new VexConfigLoader({
      homeDirectory: home,
      environment: {
        VEX_MODEL: "env/model",
        VEX_BASE_URL: "http://localhost:11434/v1",
      },
    });
    const config = await loader.resolve(root, "command/model", false);
    expect(config.agents.scout.model).toBe("command/model");
    expect(config.agents.scout.source).toBe("session");
    expect(config.provider.baseUrl).toBe("http://localhost:11434/v1");
    expect(config.maxRepairAttempts).toBe(4);
  });

  test("routes every role to an independent Provider and model", async () => {
    const { home, root } = await fixture();
    await mkdir(path.join(home, ".vex"), { recursive: true });
    await writeFile(
      path.join(home, ".vex", "config.jsonc"),
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "default-model",
        providers: {
          openai: { baseUrl: "https://api.openai.com/v1" },
          local: {
            baseUrl: "http://localhost:11434/v1",
            requiresAuth: false,
          },
        },
        agents: {
          architect: { provider: "openai", model: "reasoning-model" },
          backend: { provider: "local", model: "coding-model" },
        },
      }),
      "utf8",
    );

    const config = await new VexConfigLoader({
      homeDirectory: home,
      environment: {},
    }).resolve(root, undefined, false, {
      roleRoutes: {
        reviewer: { provider: "local", model: "review-model" },
      },
    });
    expect(config.agents.architect).toMatchObject({
      provider: "openai",
      model: "reasoning-model",
    });
    expect(config.agents.backend).toMatchObject({
      provider: "local",
      model: "coding-model",
    });
    expect(config.agents.reviewer).toMatchObject({
      provider: "local",
      model: "review-model",
      source: "session",
    });
    expect(config.providers.local!.requiresAuth).toBe(false);
  });

  test("persists interactive model routes in the user directory", async () => {
    const { home, root } = await fixture();
    const loader = new VexConfigLoader({
      homeDirectory: home,
      environment: {},
    });

    const routingPath = await loader.saveUserModelRoute(
      "session-default",
      "deepseek",
      "deepseek-v4-flash",
    );
    await loader.saveUserModelRoute(
      "reviewer",
      "anthropic",
      "claude-sonnet-4-5",
    );

    expect(routingPath).toBe(path.join(home, ".vex", "routing.json"));
    expect(JSON.parse(await readFile(routingPath, "utf8"))).toEqual({
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4-flash",
      agents: {
        reviewer: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
        },
      },
    });
    expect(await loader.userRouting()).toEqual({
      defaultProvider: "deepseek",
      defaultModel: "deepseek-v4-flash",
      agents: {
        reviewer: {
          provider: "anthropic",
          model: "claude-sonnet-4-5",
        },
      },
    });

    await mkdir(path.join(root, ".vex"), { recursive: true });
    const projectConfig = path.join(root, ".vex", "config.json");
    await writeFile(
      projectConfig,
      JSON.stringify({
        defaultProvider: "openai",
        defaultModel: "project-default",
        agents: {
          reviewer: { provider: "openai", model: "project-reviewer" },
        },
      }),
      "utf8",
    );

    const resolved = await new VexConfigLoader({
      homeDirectory: home,
      environment: {},
    }).resolve(root, undefined, true);
    expect(resolved.agents.backend).toMatchObject({
      provider: "deepseek",
      model: "deepseek-v4-flash",
    });
    expect(resolved.agents.reviewer).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-5",
    });
    expect(resolved.sources).toContain(routingPath);
    expect(resolved.sources.indexOf(routingPath)).toBeGreaterThan(
      resolved.sources.indexOf(projectConfig),
    );
  });

  test("provides Claude natively and accepts OpenAI-compatible gateways", async () => {
    const { home, root } = await fixture();
    const loader = new VexConfigLoader({
      homeDirectory: home,
      environment: {},
      inline: {
        defaultProvider: "newapi",
        defaultModel: "gateway-model",
        providers: {
          newapi: {
            protocol: "openai-chat-completions",
            baseUrl: "https://newapi.example/v1",
            apiKeyEnv: "NEWAPI_API_KEY",
          },
          sub2api: {
            protocol: "anthropic-messages",
            modelCatalog: "openai",
            baseUrl: "https://sub2api.example/v1",
            apiKeyEnv: "SUB2API_API_KEY",
          },
        },
      },
    });
    const providers = await loader.listProviders(root, false);
    expect(providers.providers.anthropic).toMatchObject({
      protocol: "anthropic-messages",
      baseUrl: "https://api.anthropic.com/v1",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    });
    expect(providers.providers.deepseek).toMatchObject({
      protocol: "openai-chat-completions",
      baseUrl: "https://api.deepseek.com/v1",
    });
    expect(providers.providers.newapi).toMatchObject({
      protocol: "openai-chat-completions",
      baseUrl: "https://newapi.example/v1",
    });
    expect(providers.providers.sub2api).toMatchObject({
      protocol: "anthropic-messages",
      modelCatalog: "openai",
      baseUrl: "https://sub2api.example/v1",
    });
  });

  test("rejects missing models, unsafe limits, and unknown keys", async () => {
    const { home, root } = await fixture();
    await expect(
      new VexConfigLoader({ homeDirectory: home, environment: {} }).resolve(root),
    ).rejects.toThrow("No model configured");
    await mkdir(path.join(root, ".vex"), { recursive: true });
    await writeFile(
      path.join(root, ".vex", "config.yml"),
      "defaultModel: model\nmaxParallelWriters: 5\nexternalPreset: omo\n",
      "utf8",
    );
    await expect(
      new VexConfigLoader({ homeDirectory: home, environment: {} }).resolve(
        root,
        undefined,
        true,
      ),
    ).rejects.toThrow();
    await expect(
      new VexConfigLoader({
        homeDirectory: home,
        environment: {},
        inline: {
          defaultModel: "model",
          provider: { baseUrl: "https://secret@example.com/v1" },
        },
      }).resolve(path.join(home, "another-root"), undefined, false),
    ).rejects.toThrow("must not contain credentials");
  });
});
