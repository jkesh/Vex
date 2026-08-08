import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";
import {
  MODEL_ROLES,
  type ModelRole,
  type RoleDefinition,
  type RoleStage,
} from "./types.js";

interface RoleFrontmatter {
  name?: string;
  description?: string;
  stage?: string;
  tools?: string[] | string;
  writes?: boolean;
  spawns?: string[];
}

function parseRoleFile(content: string, filePath: string): RoleDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content);
  if (!match) throw new Error(`Role file has no YAML frontmatter: ${filePath}`);

  const metadata = parse(match[1] ?? "") as RoleFrontmatter;
  const name = metadata.name as ModelRole;
  if (!MODEL_ROLES.includes(name))
    throw new Error(`Unknown role "${metadata.name}" in ${filePath}`);
  if (!metadata.description) throw new Error(`Role ${name} has no description`);
  if (!metadata.stage) throw new Error(`Role ${name} has no stage`);
  if (!Array.isArray(metadata.spawns) || metadata.spawns.length !== 0) {
    throw new Error(`Role ${name} must declare spawns: []`);
  }

  const tools = Array.isArray(metadata.tools)
    ? metadata.tools
    : String(metadata.tools ?? "")
        .split(",")
        .map((tool) => tool.trim())
        .filter(Boolean);

  return {
    name,
    description: metadata.description,
    stage: metadata.stage as RoleStage,
    tools,
    writes: metadata.writes === true,
    spawns: metadata.spawns,
    systemPrompt: (match[2] ?? "").trim(),
    filePath,
  };
}

export async function loadRoles(
  rolesDirectory: string,
): Promise<Map<ModelRole, RoleDefinition>> {
  const files = (await readdir(rolesDirectory))
    .filter((file) => file.endsWith(".md"))
    .sort();
  const roles = new Map<ModelRole, RoleDefinition>();

  for (const file of files) {
    const filePath = path.join(rolesDirectory, file);
    const role = parseRoleFile(await readFile(filePath, "utf8"), filePath);
    if (roles.has(role.name)) throw new Error(`Duplicate role: ${role.name}`);
    roles.set(role.name, role);
  }

  const missing = MODEL_ROLES.filter((role) => !roles.has(role));
  if (missing.length > 0)
    throw new Error(`Missing fixed roles: ${missing.join(", ")}`);
  return roles;
}
