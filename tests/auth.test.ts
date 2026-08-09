import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VexAuthStore } from "../src/auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("VEX Provider auth store", () => {
  test("persists and removes Provider API keys independently", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "vex-auth-"));
    temporaryDirectories.push(home);
    const auth = new VexAuthStore(home);

    await auth.login("OpenAI", "secret-key", "manual");
    expect(await auth.getApiKey("openai")).toBe("secret-key");
    expect(await auth.getInfo("openai")).toMatchObject({
      type: "api-key",
      source: "manual",
    });
    expect(await auth.savedCredentials()).toEqual({
      openai: expect.objectContaining({
        type: "api-key",
        source: "manual",
      }),
    });
    expect(JSON.stringify(await auth.savedCredentials())).not.toContain(
      "secret-key",
    );
    expect(await auth.loggedInProviders()).toEqual(["openai"]);
    expect(JSON.parse(await readFile(auth.filePath, "utf8"))).toMatchObject({
      version: 2,
      providers: { openai: { type: "api-key", source: "manual" } },
    });
    expect(await auth.logout("openai")).toBe(true);
    expect(await auth.getApiKey("openai")).toBeUndefined();
  });

  test("stores OAuth metadata without exposing tokens and refreshes once", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "vex-auth-oauth-"));
    temporaryDirectories.push(home);
    const now = 1_800_000_000_000;
    let refreshes = 0;
    const auth = new VexAuthStore(home, {
      now: () => now,
      fetch: async (_input, init) => {
        refreshes++;
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("grant_type")).toBe("refresh_token");
        expect(body.get("refresh_token")).toBe("refresh-secret");
        return new Response(JSON.stringify({
          access_token: "fresh-access",
          refresh_token: "fresh-refresh",
          expires_in: 3600,
        }), { status: 200 });
      },
    });

    await auth.loginOAuth("openai", {
      accessToken: "old-access",
      refreshToken: "refresh-secret",
      expiresAt: now + 30_000,
      accountId: "account-1",
    });
    const [first, second] = await Promise.all([
      auth.getAuthorization("openai"),
      auth.getAuthorization("openai"),
    ]);

    expect(first).toEqual({
      type: "oauth",
      token: "fresh-access",
      accountId: "account-1",
    });
    expect(second).toEqual(first);
    expect(refreshes).toBe(1);
    expect(await auth.getApiKey("openai")).toBeUndefined();
    expect(await auth.getInfo("openai")).toMatchObject({
      type: "oauth",
      source: "browser",
      accountId: "account-1",
    });
    const publicState = JSON.stringify(await auth.savedCredentials());
    expect(publicState).not.toContain("fresh-access");
    expect(publicState).not.toContain("fresh-refresh");
  });

  test("reads legacy API-key stores and upgrades them on the next write", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "vex-auth-legacy-"));
    temporaryDirectories.push(home);
    const auth = new VexAuthStore(home);
    await mkdir(path.dirname(auth.filePath), { recursive: true });
    await writeFile(auth.filePath, JSON.stringify({
      version: 1,
      providers: {
        openai: {
          type: "api-key",
          value: "legacy-secret",
          updatedAt: "2025-01-01T00:00:00.000Z",
        },
      },
    }));

    expect(await auth.getApiKey("openai")).toBe("legacy-secret");
    await auth.login("fixture", "fixture-secret");
    expect(JSON.parse(await readFile(auth.filePath, "utf8"))).toMatchObject({
      version: 2,
      providers: {
        openai: { type: "api-key", value: "legacy-secret" },
        fixture: { type: "api-key", value: "fixture-secret" },
      },
    });
  });
});
