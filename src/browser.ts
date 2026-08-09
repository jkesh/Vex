import { spawn } from "node:child_process";

export interface ExternalOpenCommand {
  command: string;
  args: string[];
}

function secureWebUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing to open a non-HTTPS URL: ${value}`);
  }
  return parsed.toString();
}

export function externalOpenCommand(
  value: string,
  platform: NodeJS.Platform = process.platform,
): ExternalOpenCommand {
  const url = secureWebUrl(value);
  if (platform === "win32") {
    return {
      command: "rundll32.exe",
      args: ["url.dll,FileProtocolHandler", url],
    };
  }
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  return { command: "xdg-open", args: [url] };
}

export async function openExternalUrl(value: string): Promise<void> {
  const { command, args } = externalOpenCommand(value);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
