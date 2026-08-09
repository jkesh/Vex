import {
  chmod,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { vexFetch } from "./http-client.js";
import {
  refreshOpenAiOAuthTokens,
  type OAuthFetchLike,
  type OpenAiOAuthTokens,
} from "./openai-oauth.js";

export type ApiKeySource = "manual" | "browser";

export type AuthInfo =
  | {
      type: "api-key";
      source: ApiKeySource;
      updatedAt: string;
    }
  | {
      type: "oauth";
      source: "browser";
      updatedAt: string;
      expiresAt: number;
      accountId?: string;
    };

export type ProviderAuthorization =
  | { type: "api-key"; token: string }
  | { type: "oauth"; token: string; accountId?: string };

interface ApiKeyAuthRecord {
  type: "api-key";
  value: string;
  source?: ApiKeySource;
  updatedAt: string;
}

interface OAuthAuthRecord {
  type: "oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  idToken?: string;
  accountId?: string;
  updatedAt: string;
}

type AuthRecord = ApiKeyAuthRecord | OAuthAuthRecord;

interface AuthFile {
  version: 2;
  providers: Record<string, AuthRecord>;
}

function providerId(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error(`Invalid provider ID: ${value}`);
  }
  return normalized;
}

function emptyAuth(): AuthFile {
  return { version: 2, providers: {} };
}

export interface VexAuthStoreOptions {
  fetch?: OAuthFetchLike;
  now?: () => number;
}

export class VexAuthStore {
  readonly filePath: string;
  readonly #fetch: OAuthFetchLike;
  readonly #now: () => number;
  readonly #refreshes = new Map<string, Promise<ProviderAuthorization>>();

  constructor(
    homeDirectory = os.homedir(),
    options: VexAuthStoreOptions = {},
  ) {
    this.filePath = path.join(homeDirectory, ".vex", "auth.json");
    this.#fetch = options.fetch ?? vexFetch;
    this.#now = options.now ?? Date.now;
  }

  async getApiKey(provider: string): Promise<string | undefined> {
    const record = (await this.#read()).providers[providerId(provider)];
    return record?.type === "api-key" ? record.value : undefined;
  }

  async has(provider: string): Promise<boolean> {
    return Boolean((await this.#read()).providers[providerId(provider)]);
  }

  async getInfo(provider: string): Promise<AuthInfo | undefined> {
    const record = (await this.#read()).providers[providerId(provider)];
    if (!record) return undefined;
    if (record.type === "oauth") {
      return {
        type: "oauth",
        source: "browser",
        updatedAt: record.updatedAt,
        expiresAt: record.expiresAt,
        ...(record.accountId ? { accountId: record.accountId } : {}),
      };
    }
    return {
      type: record.type,
      source: record.source ?? "manual",
      updatedAt: record.updatedAt,
    };
  }

  async savedCredentials(): Promise<Record<string, AuthInfo>> {
    const records = (await this.#read()).providers;
    return Object.fromEntries(
      Object.entries(records).map(([provider, record]) => {
        const info: AuthInfo = record.type === "oauth"
          ? {
              type: "oauth",
              source: "browser",
              updatedAt: record.updatedAt,
              expiresAt: record.expiresAt,
              ...(record.accountId ? { accountId: record.accountId } : {}),
            }
          : {
              type: "api-key",
              source: record.source ?? "manual",
              updatedAt: record.updatedAt,
            };
        return [provider, info];
      }),
    );
  }

  async getAuthorization(
    provider: string,
  ): Promise<ProviderAuthorization | undefined> {
    const id = providerId(provider);
    const record = (await this.#read()).providers[id];
    if (!record) return undefined;
    if (record.type === "api-key") {
      return { type: "api-key", token: record.value };
    }
    if (record.expiresAt > this.#now() + 5 * 60 * 1000) {
      return {
        type: "oauth",
        token: record.accessToken,
        ...(record.accountId ? { accountId: record.accountId } : {}),
      };
    }
    const active = this.#refreshes.get(id);
    if (active) return active;
    const refresh = this.#refreshOAuth(id).finally(() => {
      this.#refreshes.delete(id);
    });
    this.#refreshes.set(id, refresh);
    return refresh;
  }

  async login(
    provider: string,
    apiKey: string,
    source: ApiKeySource = "manual",
  ): Promise<void> {
    const id = providerId(provider);
    const value = apiKey.trim();
    if (!value) throw new Error("API key cannot be empty");
    const auth = await this.#read();
    auth.providers[id] = {
      type: "api-key",
      value,
      source,
      updatedAt: new Date(this.#now()).toISOString(),
    };
    await this.#write(auth);
  }

  async loginOAuth(
    provider: string,
    tokens: OpenAiOAuthTokens,
  ): Promise<void> {
    const id = providerId(provider);
    if (!tokens.accessToken || !tokens.refreshToken) {
      throw new Error("OAuth access and refresh tokens are required");
    }
    if (!Number.isFinite(tokens.expiresAt) || tokens.expiresAt <= 0) {
      throw new Error("OAuth token expiry is invalid");
    }
    const auth = await this.#read();
    auth.providers[id] = {
      type: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
      ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
      updatedAt: new Date(this.#now()).toISOString(),
    };
    await this.#write(auth);
  }

  async logout(provider: string): Promise<boolean> {
    const id = providerId(provider);
    const auth = await this.#read();
    if (!auth.providers[id]) return false;
    delete auth.providers[id];
    await this.#write(auth);
    return true;
  }

  async loggedInProviders(): Promise<string[]> {
    return Object.keys(await this.savedCredentials()).sort();
  }

  async #refreshOAuth(provider: string): Promise<ProviderAuthorization> {
    const auth = await this.#read();
    const record = auth.providers[provider];
    if (!record || record.type !== "oauth") {
      throw new Error(`No OAuth login is stored for ${provider}`);
    }
    if (record.expiresAt > this.#now() + 5 * 60 * 1000) {
      return {
        type: "oauth",
        token: record.accessToken,
        ...(record.accountId ? { accountId: record.accountId } : {}),
      };
    }
    let tokens: OpenAiOAuthTokens;
    try {
      tokens = await refreshOpenAiOAuthTokens(record.refreshToken, this.#fetch);
    } catch (error) {
      throw new Error(
        `OpenAI login expired and could not be refreshed. Run /provider openai again. ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const updated: OAuthAuthRecord = {
      type: "oauth",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      ...(tokens.idToken ?? record.idToken
        ? { idToken: tokens.idToken ?? record.idToken }
        : {}),
      ...(tokens.accountId ?? record.accountId
        ? { accountId: tokens.accountId ?? record.accountId }
        : {}),
      updatedAt: new Date(this.#now()).toISOString(),
    };
    auth.providers[provider] = updated;
    await this.#write(auth);
    return {
      type: "oauth",
      token: updated.accessToken,
      ...(updated.accountId ? { accountId: updated.accountId } : {}),
    };
  }

  async #read(): Promise<AuthFile> {
    let content: string;
    try {
      content = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyAuth();
      throw error;
    }
    const parsed = JSON.parse(content) as {
      version?: unknown;
      providers?: unknown;
    };
    if (
      (parsed.version !== 1 && parsed.version !== 2) ||
      !parsed.providers ||
      typeof parsed.providers !== "object"
    ) {
      throw new Error(`Invalid VEX auth store: ${this.filePath}`);
    }
    const providers: Record<string, AuthRecord> = {};
    for (const [provider, value] of Object.entries(parsed.providers)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Invalid VEX auth record for ${provider}`);
      }
      const record = value as Record<string, unknown>;
      if (
        record.type === "api-key" &&
        typeof record.value === "string" &&
        record.value &&
        typeof record.updatedAt === "string"
      ) {
        providers[providerId(provider)] = {
          type: "api-key",
          value: record.value,
          ...(record.source === "manual" || record.source === "browser"
            ? { source: record.source }
            : {}),
          updatedAt: record.updatedAt,
        };
        continue;
      }
      if (
        parsed.version === 2 &&
        record.type === "oauth" &&
        typeof record.accessToken === "string" &&
        record.accessToken &&
        typeof record.refreshToken === "string" &&
        record.refreshToken &&
        typeof record.expiresAt === "number" &&
        Number.isFinite(record.expiresAt) &&
        typeof record.updatedAt === "string"
      ) {
        providers[providerId(provider)] = {
          type: "oauth",
          accessToken: record.accessToken,
          refreshToken: record.refreshToken,
          expiresAt: record.expiresAt,
          ...(typeof record.idToken === "string"
            ? { idToken: record.idToken }
            : {}),
          ...(typeof record.accountId === "string"
            ? { accountId: record.accountId }
            : {}),
          updatedAt: record.updatedAt,
        };
        continue;
      }
      throw new Error(`Invalid VEX auth record for ${provider}`);
    }
    return { version: 2, providers };
  }

  async #write(auth: AuthFile): Promise<void> {
    const directory = path.dirname(this.filePath);
    const temporary = `${this.filePath}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(auth, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.filePath);
    try {
      await chmod(this.filePath, 0o600);
    } catch {
      // Windows ACLs are inherited from the user's profile directory.
    }
  }
}
