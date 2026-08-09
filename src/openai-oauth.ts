import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { openExternalUrl } from "./browser.js";
import { vexFetch } from "./http-client.js";

export const OPENAI_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const OPENAI_OAUTH_ISSUER = "https://auth.openai.com";
export const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
export const OPENAI_OAUTH_CALLBACK_PORT = 1455;
export const OPENAI_OAUTH_CALLBACK_PATH = "/auth/callback";

export type OAuthFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface OpenAiOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
  accountId?: string;
}

interface OAuthTokenPayload {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  id_token?: unknown;
}

export interface OpenAiBrowserLoginOptions {
  fetch?: OAuthFetchLike;
  openUrl?: (url: string) => Promise<void>;
  onAuthorizationUrl?: (url: string) => void;
  onBrowserOpenError?: (error: unknown) => void;
  port?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

function base64Url(value: Buffer): string {
  return value.toString("base64url");
}

export function createPkcePair(): PkcePair {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function buildOpenAiAuthorizeUrl(
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const url = new URL("/oauth/authorize", OPENAI_OAUTH_ISSUER);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: OPENAI_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access",
    code_challenge: challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: "vex",
  }).toString();
  return url.toString();
}

export function parseJwtClaims(
  token: string,
): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) return undefined;
  try {
    const parsed = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    ) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function accountIdFromClaims(
  claims: Record<string, unknown> | undefined,
): string | undefined {
  if (!claims) return undefined;
  if (typeof claims.chatgpt_account_id === "string") {
    return claims.chatgpt_account_id;
  }
  const auth = claims["https://api.openai.com/auth"];
  if (
    auth !== null &&
    typeof auth === "object" &&
    !Array.isArray(auth) &&
    typeof (auth as Record<string, unknown>).chatgpt_account_id === "string"
  ) {
    return (auth as Record<string, unknown>).chatgpt_account_id as string;
  }
  const organizations = claims.organizations;
  if (
    Array.isArray(organizations) &&
    organizations[0] !== null &&
    typeof organizations[0] === "object" &&
    typeof (organizations[0] as Record<string, unknown>).id === "string"
  ) {
    return (organizations[0] as Record<string, unknown>).id as string;
  }
  return undefined;
}

export function extractOpenAiAccountId(
  idToken: string | undefined,
  accessToken: string,
): string | undefined {
  return accountIdFromClaims(idToken ? parseJwtClaims(idToken) : undefined) ??
    accountIdFromClaims(parseJwtClaims(accessToken));
}

async function tokenRequest(
  parameters: URLSearchParams,
  fetch: OAuthFetchLike,
  fallbackRefreshToken?: string,
): Promise<OpenAiOAuthTokens> {
  const response = await fetch(`${OPENAI_OAUTH_ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: parameters.toString(),
  });
  const responseText = await response.text();
  let payload: OAuthTokenPayload;
  try {
    payload = JSON.parse(responseText) as OAuthTokenPayload;
  } catch {
    throw new Error(
      `OpenAI OAuth returned non-JSON HTTP ${response.status}: ${responseText.slice(0, 300)}`,
    );
  }
  if (!response.ok) {
    const detail = payload as Record<string, unknown>;
    const message = typeof detail.error_description === "string"
      ? detail.error_description
      : typeof detail.error === "string"
        ? detail.error
        : responseText.slice(0, 300);
    throw new Error(`OpenAI OAuth failed (${response.status}): ${message}`);
  }
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("OpenAI OAuth response did not include an access token");
  }
  const refreshToken = typeof payload.refresh_token === "string" &&
      payload.refresh_token
    ? payload.refresh_token
    : fallbackRefreshToken;
  if (!refreshToken) {
    throw new Error("OpenAI OAuth response did not include a refresh token");
  }
  const idToken = typeof payload.id_token === "string" && payload.id_token
    ? payload.id_token
    : undefined;
  const expiresIn = typeof payload.expires_in === "number" &&
      Number.isFinite(payload.expires_in)
    ? Math.max(60, payload.expires_in)
    : 3600;
  const accountId = extractOpenAiAccountId(idToken, payload.access_token);
  return {
    accessToken: payload.access_token,
    refreshToken,
    expiresAt: Date.now() + expiresIn * 1000,
    ...(idToken ? { idToken } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

export async function exchangeOpenAiAuthorizationCode(
  code: string,
  redirectUri: string,
  verifier: string,
  fetch: OAuthFetchLike = vexFetch,
): Promise<OpenAiOAuthTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: OPENAI_OAUTH_CLIENT_ID,
      code_verifier: verifier,
    }),
    fetch,
  );
}

export async function refreshOpenAiOAuthTokens(
  refreshToken: string,
  fetch: OAuthFetchLike = vexFetch,
): Promise<OpenAiOAuthTokens> {
  return tokenRequest(
    new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: OPENAI_OAUTH_CLIENT_ID,
    }),
    fetch,
    refreshToken,
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function callbackPage(title: string, detail: string, success: boolean): string {
  const color = success ? "#22c55e" : "#ef4444";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>${escapeHtml(title)}</title><style>body{background:#0b1020;color:#e5e7eb;font:16px system-ui;display:grid;place-items:center;min-height:100vh;margin:0}.card{max-width:560px;padding:32px;border:1px solid #293247;border-radius:16px;background:#111827}h1{color:${color};font-size:24px}p{line-height:1.6;color:#cbd5e1}</style></head><body><main class="card"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p></main></body></html>`;
}

function sendHtml(
  response: ServerResponse,
  status: number,
  title: string,
  detail: string,
  success: boolean,
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(callbackPage(title, detail, success));
}

function isLoopbackRequest(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress;
  return address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1";
}

export async function loginWithOpenAiBrowser(
  options: OpenAiBrowserLoginOptions = {},
): Promise<OpenAiOAuthTokens> {
  const fetch = options.fetch ?? vexFetch;
  const openUrl = options.openUrl ?? openExternalUrl;
  const pkce = createPkcePair();
  const state = base64Url(randomBytes(32));
  const timeoutMs = options.timeoutMs ?? 5 * 60 * 1000;
  const requestedPort = options.port ?? OPENAI_OAUTH_CALLBACK_PORT;

  let resolveCallback!: (tokens: OpenAiOAuthTokens) => void;
  let rejectCallback!: (error: Error) => void;
  let settled = false;
  let redirectUri = "";
  const callback = new Promise<OpenAiOAuthTokens>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  const settle = (
    outcome: { tokens: OpenAiOAuthTokens } | { error: Error },
  ): void => {
    if (settled) return;
    settled = true;
    if ("tokens" in outcome) resolveCallback(outcome.tokens);
    else rejectCallback(outcome.error);
  };

  const server = createServer(async (request, response) => {
    if (!isLoopbackRequest(request)) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    if (url.pathname !== OPENAI_OAUTH_CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const oauthError = url.searchParams.get("error");
    if (oauthError) {
      const detail = url.searchParams.get("error_description") ?? oauthError;
      sendHtml(response, 400, "VEX login failed", detail, false);
      settle({ error: new Error(`OpenAI authorization failed: ${detail}`) });
      return;
    }
    if (url.searchParams.get("state") !== state) {
      const detail = "The OAuth state did not match. Please start login again.";
      sendHtml(response, 400, "VEX login rejected", detail, false);
      settle({ error: new Error("OpenAI OAuth state mismatch") });
      return;
    }
    const code = url.searchParams.get("code");
    if (!code) {
      const detail = "The authorization response did not include a code.";
      sendHtml(response, 400, "VEX login failed", detail, false);
      settle({ error: new Error("OpenAI OAuth callback is missing the code") });
      return;
    }
    try {
      const tokens = await exchangeOpenAiAuthorizationCode(
        code,
        redirectUri,
        pkce.verifier,
        fetch,
      );
      sendHtml(
        response,
        200,
        "VEX is connected",
        "Authorization completed. You can close this browser tab and return to VEX.",
        true,
      );
      settle({ tokens });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      sendHtml(response, 502, "VEX login failed", detail, false);
      settle({ error: error instanceof Error ? error : new Error(detail) });
    }
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(requestedPort, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("VEX could not determine the OAuth callback port");
    }
    redirectUri = `http://localhost:${address.port}${OPENAI_OAUTH_CALLBACK_PATH}`;
    const authorizationUrl = buildOpenAiAuthorizeUrl(
      redirectUri,
      pkce.challenge,
      state,
    );
    options.onAuthorizationUrl?.(authorizationUrl);
    try {
      await openUrl(authorizationUrl);
    } catch (error) {
      options.onBrowserOpenError?.(error);
    }

    const timer = setTimeout(
      () => settle({ error: new Error("OpenAI browser login timed out") }),
      timeoutMs,
    );
    timer.unref();
    const abort = () => settle({ error: new Error("OpenAI browser login cancelled") });
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await callback;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        `OpenAI login callback port ${requestedPort} is already in use`,
      );
    }
    throw error;
  } finally {
    await new Promise<void>((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}
