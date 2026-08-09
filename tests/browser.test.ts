import { describe, expect, test } from "bun:test";
import { externalOpenCommand } from "../src/browser.js";

const AUTHORIZATION_URL = "https://auth.openai.com/oauth/authorize";

describe("secure browser launcher", () => {
  test("uses the default browser handler on Windows", () => {
    expect(externalOpenCommand(AUTHORIZATION_URL, "win32")).toEqual({
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", AUTHORIZATION_URL],
    });
  });

  test("uses native launchers on macOS and Linux", () => {
    expect(externalOpenCommand(AUTHORIZATION_URL, "darwin")).toEqual({
      command: "open",
      args: [AUTHORIZATION_URL],
    });
    expect(externalOpenCommand(AUTHORIZATION_URL, "linux")).toEqual({
      command: "xdg-open",
      args: [AUTHORIZATION_URL],
    });
  });

  test("refuses non-HTTPS destinations", () => {
    expect(() => externalOpenCommand("http://example.test", "win32")).toThrow(
      "non-HTTPS",
    );
  });
});
