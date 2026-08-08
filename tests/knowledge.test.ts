import { describe, expect, test } from "bun:test";
import {
  NoopKnowledgeProvider,
  RoleKnowledgeClient,
  type RoleKnowledgeProvider,
} from "../src/knowledge.js";

describe("RoleKnowledgeClient", () => {
  test("the default provider is a stable no-op", async () => {
    const client = new RoleKnowledgeClient(new NoopKnowledgeProvider());
    const documents = await client.retrieve({
      role: "scout",
      query: "map the project",
      cwd: "/repo",
      runId: "run-1",
    });
    expect(documents).toEqual([]);
  });

  test("bounds provider results and document size", async () => {
    const provider: RoleKnowledgeProvider = {
      name: "fixture",
      async retrieve() {
        return {
          provider: "fixture",
          documents: [
            { id: "a", content: "123456" },
            { id: "b", content: "abcdef" },
          ],
        };
      },
    };
    const client = new RoleKnowledgeClient(provider, {
      limit: 1,
      maxDocumentCharacters: 4,
    });
    const documents = await client.retrieve({
      role: "backend",
      query: "implement",
      cwd: "/repo",
      runId: "run-2",
    });
    expect(documents).toEqual([{ id: "a", content: "1234" }]);
  });

  test("fails open by default", async () => {
    const provider: RoleKnowledgeProvider = {
      name: "broken",
      async retrieve() {
        throw new Error("offline");
      },
    };
    const client = new RoleKnowledgeClient(provider);
    expect(
      await client.retrieve({
        role: "reviewer",
        query: "review",
        cwd: "/repo",
        runId: "run-3",
      }),
    ).toEqual([]);
  });
});
