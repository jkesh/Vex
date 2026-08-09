import { describe, expect, test } from "bun:test";
import {
  buildOpenAiAuthorizeUrl,
  loginWithOpenAiBrowser,
  OPENAI_OAUTH_CALLBACK_PATH,
  OPENAI_OAUTH_CLIENT_ID,
} from "../src/openai-oauth.js";

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("OpenAI browser OAuth", () => {
  test("builds the VEX PKCE authorization request", () => {
    const result = new URL(buildOpenAiAuthorizeUrl(
      "http://localhost:1455/auth/callback",
      "pkce-challenge",
      "oauth-state",
    ));
    expect(result.origin).toBe("https://auth.openai.com");
    expect(result.pathname).toBe("/oauth/authorize");
    expect(result.searchParams.get("client_id")).toBe(OPENAI_OAUTH_CLIENT_ID);
    expect(result.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback",
    );
    expect(result.searchParams.get("code_challenge_method")).toBe("S256");
    expect(result.searchParams.get("code_challenge")).toBe("pkce-challenge");
    expect(result.searchParams.get("state")).toBe("oauth-state");
    expect(result.searchParams.get("originator")).toBe("vex");
    expect(result.searchParams.get("scope")).toContain("offline_access");
  });

  test("opens the browser, accepts the localhost callback, and exchanges the code", async () => {
    const idToken = jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "account-42" },
    });
    let tokenBody: URLSearchParams | undefined;
    let authorizationUrl = "";
    let callbackPage: Promise<string> | undefined;
    const tokens = await loginWithOpenAiBrowser({
      port: 0,
      timeoutMs: 5_000,
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://auth.openai.com/oauth/token");
        tokenBody = new URLSearchParams(String(init?.body));
        return new Response(JSON.stringify({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          id_token: idToken,
          expires_in: 3600,
        }), { status: 200 });
      },
      onAuthorizationUrl(url) {
        authorizationUrl = url;
      },
      async openUrl(url) {
        const authorization = new URL(url);
        const redirectUri = authorization.searchParams.get("redirect_uri")!;
        const state = authorization.searchParams.get("state")!;
        callbackPage = globalThis.fetch(
          `${redirectUri}?code=authorization-code&state=${encodeURIComponent(state)}`,
        ).then(async (response) => {
          expect(response.status).toBe(200);
          return response.text();
        });
      },
    });

    expect(new URL(authorizationUrl).searchParams.get("originator")).toBe("vex");
    const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri")!;
    expect(new URL(redirectUri).pathname).toBe(OPENAI_OAUTH_CALLBACK_PATH);
    expect(tokens).toMatchObject({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      idToken,
      accountId: "account-42",
    });
    expect(tokenBody?.get("grant_type")).toBe("authorization_code");
    expect(tokenBody?.get("code")).toBe("authorization-code");
    expect(tokenBody?.get("redirect_uri")).toBe(redirectUri);
    expect(tokenBody?.get("client_id")).toBe(OPENAI_OAUTH_CLIENT_ID);
    expect(tokenBody?.get("code_verifier")?.length).toBeGreaterThan(40);
    expect(await callbackPage).toContain("VEX is connected");
  });

  test("rejects a callback with the wrong OAuth state", async () => {
    let callbackPage: Promise<string> | undefined;
    await expect(loginWithOpenAiBrowser({
      port: 0,
      timeoutMs: 5_000,
      fetch: async () => {
        throw new Error("token exchange must not run");
      },
      async openUrl(url) {
        const redirectUri = new URL(url).searchParams.get("redirect_uri")!;
        callbackPage = globalThis.fetch(
          `${redirectUri}?code=authorization-code&state=wrong-state`,
        ).then((response) => response.text());
      },
    })).rejects.toThrow("state mismatch");
    expect(await callbackPage).toContain("VEX login rejected");
  });
});
