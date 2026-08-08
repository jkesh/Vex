import type { KnowledgeDocument, ModelRole } from "./types.js";

export interface RoleKnowledgeRequest {
  role: ModelRole;
  query: string;
  cwd: string;
  runId: string;
  limit: number;
  signal?: AbortSignal;
  filters?: Record<string, unknown>;
}

export interface RoleKnowledgeResponse {
  documents: KnowledgeDocument[];
  provider: string;
  elapsedMs?: number;
}

export interface RoleKnowledgeProvider {
  readonly name: string;
  retrieve(request: RoleKnowledgeRequest): Promise<RoleKnowledgeResponse>;
}

export interface RoleKnowledgeClientOptions {
  limit?: number;
  maxDocumentCharacters?: number;
  failOpen?: boolean;
}

export class NoopKnowledgeProvider implements RoleKnowledgeProvider {
  readonly name = "noop";

  async retrieve(): Promise<RoleKnowledgeResponse> {
    return { provider: this.name, documents: [] };
  }
}

export class RoleKnowledgeClient {
  readonly #provider: RoleKnowledgeProvider;
  readonly #limit: number;
  readonly #maxDocumentCharacters: number;
  readonly #failOpen: boolean;

  constructor(
    provider: RoleKnowledgeProvider = new NoopKnowledgeProvider(),
    options: RoleKnowledgeClientOptions = {},
  ) {
    this.#provider = provider;
    this.#limit = options.limit ?? 8;
    this.#maxDocumentCharacters = options.maxDocumentCharacters ?? 4_000;
    this.#failOpen = options.failOpen ?? true;
  }

  async retrieve(
    request: Omit<RoleKnowledgeRequest, "limit">,
  ): Promise<KnowledgeDocument[]> {
    try {
      const response = await this.#provider.retrieve({
        ...request,
        limit: this.#limit,
      });
      return response.documents.slice(0, this.#limit).map((document) => ({
        ...document,
        content: document.content.slice(0, this.#maxDocumentCharacters),
      }));
    } catch (error) {
      if (!this.#failOpen) throw error;
      return [];
    }
  }
}
