import { describe, expect, test } from "bun:test";
import {
  describeProxyForUrl,
  parseWindowsProxyRegistry,
  redactProxyUrl,
  resolveProxyForUrl,
} from "../src/http-client.js";

describe("VEX HTTP proxy resolution", () => {
  test("parses the Windows user proxy used by v2rayN", () => {
    const settings = parseWindowsProxyRegistry(`
HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings
    ProxyEnable    REG_DWORD    0x1
    ProxyServer    REG_SZ       127.0.0.1:10808
    ProxyOverride  REG_SZ       localhost;127.*;<local>
`);
    expect(settings).toEqual({
      enabled: true,
      server: "127.0.0.1:10808",
      override: "localhost;127.*;<local>",
    });
    expect(resolveProxyForUrl("https://auth.openai.com/oauth/token", {
      environment: {},
      platform: "win32",
      windowsProxy: settings,
    })).toEqual({
      url: "http://127.0.0.1:10808/",
      source: "Windows system",
    });
  });

  test("uses explicit and environment proxies before Windows settings", () => {
    const windowsProxy = { enabled: true, server: "127.0.0.1:10808" };
    expect(resolveProxyForUrl("https://auth.openai.com", {
      environment: { VEX_PROXY: "http://127.0.0.1:20808" },
      platform: "win32",
      windowsProxy,
    })?.source).toBe("VEX_PROXY");
    expect(resolveProxyForUrl("https://auth.openai.com", {
      environment: { HTTPS_PROXY: "http://127.0.0.1:30808" },
      platform: "win32",
      windowsProxy,
    })).toEqual({
      url: "http://127.0.0.1:30808/",
      source: "environment",
    });
  });

  test("always keeps localhost direct and honors bypass controls", () => {
    const options = {
      environment: { VEX_PROXY: "http://127.0.0.1:10808" },
      platform: "win32" as const,
      windowsProxy: { enabled: true, server: "127.0.0.1:10808" },
    };
    expect(resolveProxyForUrl("http://localhost:1455/auth/callback", options))
      .toBeUndefined();
    expect(resolveProxyForUrl("http://127.0.0.1:11434/v1/models", options))
      .toBeUndefined();
    expect(resolveProxyForUrl("https://api.example.test", {
      ...options,
      environment: {
        VEX_PROXY: "http://127.0.0.1:10808",
        VEX_NO_PROXY: ".example.test",
      },
    })).toBeUndefined();
    expect(resolveProxyForUrl("https://auth.openai.com", {
      ...options,
      environment: { VEX_PROXY: "direct" },
    })).toBeUndefined();
  });

  test("selects protocol-specific Windows entries and redacts credentials", () => {
    const decision = resolveProxyForUrl("https://auth.openai.com", {
      environment: {},
      platform: "win32",
      windowsProxy: {
        enabled: true,
        server: "http=127.0.0.1:10808;https=127.0.0.1:10809",
      },
    });
    expect(decision?.url).toBe("http://127.0.0.1:10809/");
    expect(redactProxyUrl("http://user:secret@proxy.example:8080")).toBe(
      "http://proxy.example:8080",
    );
    expect(describeProxyForUrl("https://auth.openai.com", {
      environment: { VEX_PROXY: "http://user:secret@proxy.example:8080" },
      platform: "linux",
    })).toBe("VEX_PROXY proxy http://proxy.example:8080");
  });

  test("rejects SOCKS-only proxy URLs with an actionable message", () => {
    expect(() => resolveProxyForUrl("https://auth.openai.com", {
      environment: { VEX_PROXY: "socks5://127.0.0.1:10808" },
      platform: "linux",
    })).toThrow("HTTP or mixed port");
  });
});
