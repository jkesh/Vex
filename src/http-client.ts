import { execFileSync } from "node:child_process";
import {
  fetch as undiciFetch,
  ProxyAgent,
} from "undici";

export type VexFetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface WindowsProxySettings {
  enabled: boolean;
  server?: string;
  override?: string;
}

export interface ProxyDecision {
  url: string;
  source: "VEX_PROXY" | "environment" | "Windows system";
}

export interface ProxyResolutionOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  windowsProxy?: WindowsProxySettings;
}

const WINDOWS_INTERNET_SETTINGS =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const proxyAgents = new Map<string, ProxyAgent>();
let windowsProxyLoaded = false;
let cachedWindowsProxy: WindowsProxySettings | undefined;

function environmentValue(
  environment: NodeJS.ProcessEnv,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = environment[name];
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function registryValue(output: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return output.match(
    new RegExp(`^\\s*${escaped}\\s+REG_\\w+\\s+(.+?)\\s*$`, "mi"),
  )?.[1]?.trim();
}

export function parseWindowsProxyRegistry(
  output: string,
): WindowsProxySettings {
  const enabledValue = registryValue(output, "ProxyEnable");
  const server = registryValue(output, "ProxyServer");
  const override = registryValue(output, "ProxyOverride");
  return {
    enabled: enabledValue === "0x1" || enabledValue === "1",
    ...(server ? { server } : {}),
    ...(override ? { override } : {}),
  };
}

export function readWindowsProxySettings(): WindowsProxySettings | undefined {
  if (process.platform !== "win32") return undefined;
  if (windowsProxyLoaded) return cachedWindowsProxy;
  windowsProxyLoaded = true;
  try {
    const output = execFileSync(
      "reg.exe",
      ["query", WINDOWS_INTERNET_SETTINGS],
      {
        encoding: "utf8",
        windowsHide: true,
        timeout: 2_000,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    cachedWindowsProxy = parseWindowsProxyRegistry(output);
  } catch {
    cachedWindowsProxy = undefined;
  }
  return cachedWindowsProxy;
}

function loopback(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" ||
    value === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(value);
}

function bypassEntryMatches(url: URL, rawEntry: string): boolean {
  let entry = rawEntry.trim().toLowerCase();
  if (!entry) return false;
  if (entry === "*") return true;
  if (entry === "<local>") return !url.hostname.includes(".");
  if (entry.includes("://")) {
    try {
      entry = new URL(entry).host.toLowerCase();
    } catch {
      return false;
    }
  }
  const slash = entry.indexOf("/");
  if (slash >= 0) entry = entry.slice(0, slash);
  const hostname = url.hostname.toLowerCase();
  const host = url.host.toLowerCase();
  if (entry.startsWith("*.")) entry = entry.slice(1);
  if (entry.startsWith(".")) {
    return hostname === entry.slice(1) || hostname.endsWith(entry);
  }
  return entry === hostname || entry === host;
}

function bypassesProxy(url: URL, bypassList: string | undefined): boolean {
  if (loopback(url.hostname)) return true;
  return Boolean(
    bypassList?.split(/[;,]/).some((entry) => bypassEntryMatches(url, entry)),
  );
}

function windowsProxyServer(
  settings: WindowsProxySettings | undefined,
  protocol: string,
): string | undefined {
  if (!settings?.enabled || !settings.server?.trim()) return undefined;
  const value = settings.server.trim();
  if (!value.includes("=")) return value;
  const servers = new Map<string, string>();
  for (const item of value.split(";")) {
    const separator = item.indexOf("=");
    if (separator <= 0) continue;
    servers.set(
      item.slice(0, separator).trim().toLowerCase(),
      item.slice(separator + 1).trim(),
    );
  }
  const name = protocol === "https:" ? "https" : "http";
  return servers.get(name) ?? (name === "https" ? servers.get("http") : undefined);
}

function normalizeProxyUrl(value: string): string {
  const trimmed = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error("Invalid proxy URL. Use http://host:port or https://host:port.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `Unsupported proxy protocol ${url.protocol} Use v2rayN's HTTP or mixed port.`,
    );
  }
  if (!url.hostname || !url.port) {
    throw new Error("Proxy URL must include a host and port.");
  }
  return url.toString();
}

function directProxySetting(value: string | undefined): boolean {
  return Boolean(value && ["direct", "off", "none", "false", "0"].includes(
    value.trim().toLowerCase(),
  ));
}

export function resolveProxyForUrl(
  input: string | URL,
  options: ProxyResolutionOptions = {},
): ProxyDecision | undefined {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  const environment = options.environment ?? process.env;
  const explicit = environmentValue(environment, "VEX_PROXY", "vex_proxy");
  const environmentBypass = [
    environmentValue(environment, "VEX_NO_PROXY", "vex_no_proxy"),
    environmentValue(environment, "NO_PROXY", "no_proxy"),
  ].filter(Boolean).join(",");
  if (bypassesProxy(url, environmentBypass)) return undefined;
  if (directProxySetting(explicit)) return undefined;
  if (explicit) {
    return { url: normalizeProxyUrl(explicit), source: "VEX_PROXY" };
  }

  const environmentProxy = url.protocol === "https:"
    ? environmentValue(
        environment,
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "HTTP_PROXY",
        "http_proxy",
      )
    : environmentValue(
        environment,
        "HTTP_PROXY",
        "http_proxy",
        "ALL_PROXY",
        "all_proxy",
      );
  if (directProxySetting(environmentProxy)) return undefined;
  if (environmentProxy) {
    return { url: normalizeProxyUrl(environmentProxy), source: "environment" };
  }

  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return undefined;
  const settings = options.windowsProxy ?? readWindowsProxySettings();
  if (bypassesProxy(url, settings?.override)) return undefined;
  const server = windowsProxyServer(settings, url.protocol);
  return server
    ? { url: normalizeProxyUrl(server), source: "Windows system" }
    : undefined;
}

function proxyAgent(url: string): ProxyAgent {
  const existing = proxyAgents.get(url);
  if (existing) return existing;
  const created = new ProxyAgent(url);
  proxyAgents.set(url, created);
  return created;
}

export function redactProxyUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return "configured proxy";
  }
}

export function describeProxyForUrl(
  input: string | URL,
  options: ProxyResolutionOptions = {},
): string | undefined {
  const decision = resolveProxyForUrl(input, options);
  return decision
    ? `${decision.source} proxy ${redactProxyUrl(decision.url)}`
    : undefined;
}

export const vexFetch: VexFetchLike = async (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input);
  const decision = resolveProxyForUrl(requestUrl);
  const response = await undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    ...(decision ? { dispatcher: proxyAgent(decision.url) } : {}),
  });
  return response as unknown as Response;
};
