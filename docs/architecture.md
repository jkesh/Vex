# VEX Architecture

## Package Boundary

VEX ships as a Pi package with one extension entrypoint. Pi remains responsible for model providers, authentication, the interactive terminal, context loading, and coding tools. VEX owns fixed-role prompts, child-session creation, worktree isolation, orchestration state, policy checks, integration order, and the role knowledge interface.

The implementation uses TypeScript and Node-compatible APIs so Pi can load the extension directly. Bun is the development runtime and test runner.

## Fixed Roles

Role definitions live in `roles/*.md` with YAML frontmatter. The loader requires exactly the seven model roles, rejects unknown or duplicate role names, and requires `spawns: []` for every role.

Writer roles are `backend`, `frontend`, and `test-engineer`. Analysis and review roles do not receive `edit` or `write`. `integrator` is not a model role; it is implemented by `WorktreeManager`.

## Execution Flow

1. Preflight resolves the repository root, active branch, and base commit, then requires a clean working tree.
2. `scout` maps relevant code and constraints in the original read-only worktree.
3. `architect` returns an `ExecutionManifest` for all three writer roles.
4. VEX creates backend and frontend worktrees from the same base and runs both roles concurrently.
5. The ownership policy rejects protected paths, cross-domain edits, and overlapping ownership.
6. The integrator cherry-picks backend and frontend commits in a fixed order into an integration worktree.
7. `test-engineer` starts from the integrated commit, adds focused coverage, and is cherry-picked into integration.
8. `reviewer` and optional `security-reviewer` inspect the integrated result without write tools.
9. After approval, VEX verifies that the original branch and worktree are unchanged and performs a fast-forward merge.
10. Successful runs remove temporary worktrees and branches. Failed or aborted runs retain them for `/vex-cleanup`.

The orchestrator always invokes the fixed backend, frontend, and test roles. A role returns `skipped` when the assignment has no work in its direction. The architect can narrow objectives and owned paths but cannot create new roles or change integration order.

## Child Protocol

Each role runs as a separate non-interactive Pi process in JSON mode. VEX explicitly loads its extension into the child and exposes `team_yield` only when `VEX_CHILD=1`. The tool validates the expected role, emits a `VEX_TEAM_YIELD:` JSON record, and terminates the child turn.

Core result shapes are:

- `ScoutReport`
- `ExecutionManifest`
- `ChangeResult`
- `ReviewReport` and `ReviewFinding`
- `RoleYield`

VEX also checks Git directly. A writer that leaves uncommitted changes fails the run, and commit lists and changed paths are derived from Git rather than trusted from model output.

## State

Every run persists `state.json` under the Git common directory:

```text
.git/vex/runs/<run-id>/
  state.json
  prompts/
    scout.md
    architect.md
    backend.md
    frontend.md
    test-engineer.md
    reviewer.md
    security-reviewer.md
```

The state records the immutable base ref, phase, role states, worktree records, original writer commits, integrated commit inputs, final ref, and failure details. Atomic replacement prevents partially written JSON files.

## Role Knowledge Interface

`RoleKnowledgeProvider.retrieve()` is the only retrieval contract used by the orchestrator. Every role receives an independent request containing its role name, task query, repository path, run ID, result limit, optional filters, and abort signal.

`RoleKnowledgeClient` applies common bounds before text enters a model prompt. `NoopKnowledgeProvider` is the default. Concrete providers can implement dense retrieval, sparse search, hybrid retrieval, graph traversal, reranking, a remote RAG API, or an MCP adapter behind the same contract.
