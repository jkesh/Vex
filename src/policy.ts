import type { WriterRole } from "./types.js";

export interface PolicyViolation {
  role: WriterRole;
  path: string;
  rule: "protected-path" | "role-boundary" | "cross-role-conflict";
  message: string;
}

const PROTECTED_PATHS = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)\.vex(\/|$)/i,
  /(^|\/)\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx)$/i,
];

const FRONTEND_PATH =
  /(^|\/)(?:ui|web|frontend|client|components?|pages?|views?|styles?)(\/|$)/i;
const BACKEND_PATH =
  /(^|\/)(?:api|server|backend|database|migrations?|repositories|services?)(\/|$)/i;
const TEST_PATH =
  /(^|\/)(?:tests?|__tests__|spec|fixtures?)(\/|$)|\.(?:test|spec)\.[^.]+$/i;

export class FileOwnershipPolicy {
  check(
    role: WriterRole,
    files: string[],
    existing: ReadonlyMap<string, WriterRole>,
  ): PolicyViolation[] {
    const violations: PolicyViolation[] = [];

    for (const rawPath of files) {
      const file = rawPath.replaceAll("\\", "/");
      if (PROTECTED_PATHS.some((pattern) => pattern.test(file))) {
        violations.push({
          role,
          path: file,
          rule: "protected-path",
          message: `${file} is managed by VEX or contains secrets`,
        });
      }

      if (
        role === "backend" &&
        FRONTEND_PATH.test(file) &&
        !TEST_PATH.test(file)
      ) {
        violations.push({
          role,
          path: file,
          rule: "role-boundary",
          message: "backend changed a frontend-owned path",
        });
      }
      if (
        role === "frontend" &&
        BACKEND_PATH.test(file) &&
        !TEST_PATH.test(file)
      ) {
        violations.push({
          role,
          path: file,
          rule: "role-boundary",
          message: "frontend changed a backend-owned path",
        });
      }
      if (
        role === "test-engineer" &&
        !TEST_PATH.test(file) &&
        !/^(?:README|docs\/)/i.test(file)
      ) {
        violations.push({
          role,
          path: file,
          rule: "role-boundary",
          message: "test-engineer changed a non-test path",
        });
      }

      const owner = existing.get(file);
      if (owner && owner !== role) {
        violations.push({
          role,
          path: file,
          rule: "cross-role-conflict",
          message: `${file} is already owned by ${owner}`,
        });
      }
    }

    return violations;
  }
}
