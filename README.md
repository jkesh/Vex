# VEX

VEX is an independent adaptive engineering CLI. It owns its terminal interface, semantic work-mode routing, model-provider connection, fixed roles, agent tools, sessions, orchestration state, Git worktrees, review loop, and merge gate.

It is not a Pi extension and does not load OMP, oh-my-openagent, OpenCode, or their configuration. VEX owns its provider transport: OpenAI-compatible Providers use Chat Completions, Anthropic uses native Messages, and an OpenAI ChatGPT OAuth session uses the Codex Responses backend.

## CLI workspace

Running `vex` without arguments opens a direct natural-language session. There is no mode-selection screen: each prompt is routed to conversation, read-only technical review, reviewer-only code review, or implementation from its meaning.

```text
┌ VEX • adaptive agent session ─────────────────────────────────────────┐
│ repository  D:\work\application                                      │
│ branch      main@8d2b143a20 clean                                    │
│ latest      awaiting-merge · 20260808T...                            │
├──────────────────────────────────────────────────────────────────────┤
│ PROMPT                                                               │
│  Type naturally; auto selects chat, review, code-review, implement.  │
│  Type / for hints; Up recalls history; Tab completes.                │
│  /mode auto|chat|review|code-review|implement                        │
│  /provider · /model (two-pane Provider/model selector)              │
│  /route (per-role routing) · /help · /quit                           │
├──────────────────────────────────────────────────────────────────────┤
│ Native VEX runtime • fixed roles • isolated worktrees                │
└──────────────────────────────────────────────────────────────────────┘
› 修复登录接口，并补充回归测试
```

Plain text enters `auto` mode; no numbered action menu is required. Clear implementation requests start the full plan/implementation workflow, broad read-only assessments launch Scout followed by Technical Reviewer, explicit code-review requests launch only Reviewer, and conversational questions receive a direct answer without workspace access. `/mode auto|chat|review|code-review|implement` overrides routing for later prompts. At a normal prompt, Up (or Ctrl+P) recalls earlier prompts and commands, while Down (or Ctrl+N) moves forward and restores an unfinished draft. Typing `/` opens a live, filtered command panel; there Up/Down changes the highlighted suggestion and Tab completes it. The same panel suggests known Providers, modes, roles, authentication methods, and discovered models while arguments are typed. `/provider` is the single Provider selection and authentication command. `/model` opens a full-screen selector with Providers on the left and that Provider's models on the right. Click either pane with the mouse, use the mouse wheel to scroll, or use Left/Right, Up/Down, typing, Enter, and Esc. After assigning a model to the session default or an Agent role, VEX saves the route immediately and returns to the model selector. Repeat for additional roles, then press Esc to finish and return to the prompt.

## Install and run locally

Requirements: Node.js 22+ and the Git executable. OpenAI can be connected through browser-based ChatGPT OAuth without entering an API key, or through an API key. Claude uses Anthropic's native Messages protocol; DeepSeek, NewAPI, Sub2API, OpenRouter, Ollama, and other gateways can use the OpenAI-compatible protocol. Git is VEX's internal isolation engine, but the source folder itself does not need to be a repository. Bun is used only for development tests.

```powershell
git clone https://github.com/jkesh/Vex.git
cd Vex
npm.cmd run setup
```

`npm.cmd run setup` installs dependencies, builds VEX, and registers the global `vex` command. Run it again after pulling a new release. Configuration is created automatically when needed; `vex init --global` remains available when you want an editable starter file.

Choose a Provider, log in, select a model, then launch VEX from any folder:

```powershell
cd D:\your-project
vex
# Inside VEX:
# /provider                      choose a Provider; connect if required
# /provider openai oauth         authorize VEX in the browser; no key prompt
# /model                         choose Provider/model, then a target role
# /route                         choose Provider/model, then one Agent role
```

Git is optional. In an ordinary directory, VEX creates a private managed snapshot under `~/.vex/workspaces`, runs every role in isolated worktrees, and applies reviewed changes back only after `/merge`. It never creates `.git` in the user's directory.

Without `npm link`:

```powershell
node D:\Vex\dist\cli.js --help
node D:\Vex\dist\cli.js run "implement the feature"
```

## Commands

```text
vex                              interactive workspace
vex <prompt>                     automatically select a work mode
vex chat <message>               pure conversation, no workspace tools
vex assess <scope>               read-only technical review
vex code-review <scope>          read-only review using only Reviewer
vex run <task>                   plan, confirm, and execute
vex code <task>                  alias for run
vex plan <task>                  create a plan without writers
vex status [run-id]              show the team dashboard
vex status --json [run-id]       output persisted state as JSON
vex usage [run-id]               show Token use by Agent, Provider, and model
vex usage --json [run-id]        output machine-readable Token usage
vex diff [run-id]                show the unmerged integration diff
vex resume [run-id]              resume a plan or interrupted run
vex review [run-id]              rerun reviewers
vex merge [run-id]               explicitly fast-forward an approved run
vex abort [run-id]               terminate or mark a run aborted
vex cleanup [run-id]             remove retained worktrees and branches
vex config                       show provider and role models
vex providers                    list Provider profiles and login status
vex models [provider]            list all connected catalogs, or one Provider
vex provider [provider] [method] select and securely connect a Provider
vex logout [provider]            select and remove a saved Provider login
vex init [--global]              create a VEX config
```

## Adaptive work modes

| Mode | Natural-language intent | Capabilities |
| --- | --- | --- |
| `chat` | Questions, explanations, brainstorming, general conversation | Model conversation only. It receives no filesystem, shell, Git, or editing tools. |
| `review` | Review, audit, inspect, assess, analyze, or explicitly “do not modify” | Read-only Scout followed by Technical Reviewer. Only `read`, `ls`, `find`, `grep`, and structured yield are available. |
| `code-review` | Explicit code review of a repository or source scope without fixes | Only the read-only Reviewer runs. Scout, writers, shell, edits, delegation, and merge are unavailable. |
| `implement` | Implement, fix, refactor, add, remove, migrate, or otherwise change the workspace | Full VEX manifest, isolated writer worktrees, verification, review/repair, diff, and explicit merge gate. |
| `auto` | Default | Uses high-confidence multilingual intent rules first. Ambiguous prompts use the configured model as a semantic classifier; if classification is unavailable, VEX falls back to non-mutating chat. |

Examples inside the interactive workspace:

```text
解释一下 worktree 的作用                 -> chat
只评审当前认证架构，不要修改代码          -> review
审查当前代码仓库                         -> code-review (Reviewer only)
实现登录接口并补充测试                    -> implement

/mode review                              force review for later prompts
/mode code-review                         force reviewer-only code review
/mode chat                                force pure conversation
/mode implement                           force the full implementation flow
/mode auto                                restore semantic routing
/chat <message>                           one explicit chat turn
/assess <scope>                           one explicit read-only review
/code-review <scope>                      one explicit Reviewer-only review
/run <task>                               one explicit implementation run
```

Short continuation prompts such as `继续` inherit the previously resolved mode. Review reports and model transcripts are stored under `~/.vex/reviews/<workspace-id>/`; neither review mode creates a Git repository or changes workspace files. Chat and prompt history stay in memory for the current VEX process.

Mode calls honor the same independent role routing: the `architect` route supplies chat and ambiguous-intent classification, `scout` plus `reviewer` supply broad technical review, and `reviewer` alone supplies code review. Configure them permanently under `agents` or temporarily with `/route architect ...`, `/route scout ...`, and `/route reviewer ...`. Implementation continues to use every configured fixed-role route.

Run options:

```text
--model <id>                     override all role models for one run
--provider <id>                  override the default Provider for one run
--security                       enable Security Reviewer
--trust-project                  load <repo>/.vex/config.*
--yes                            accept execution without an interactive prompt
```

`--yes` never merges. Only `vex merge` changes the original workspace.

## Independent configuration

VEX reads only these layers, from lower to higher precedence:

```text
~/.vex/config.{jsonc,json,yaml,yml}
<repo>/.vex/config.{jsonc,json,yaml,yml}  only with --trust-project
VEX_CONFIG=/absolute/path/to/config.jsonc
command and VEX_* environment overrides
```

Example:

```jsonc
{
  "defaultProvider": "openai",
  "defaultModel": "coding-model",
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "apiKeyEnv": "VEX_API_KEY"
    },
    "openrouter": {
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKeyEnv": "OPENROUTER_API_KEY"
    },
    "anthropic": {
      "protocol": "anthropic-messages",
      "baseUrl": "https://api.anthropic.com/v1",
      "apiKeyEnv": "ANTHROPIC_API_KEY"
    },
    "newapi": {
      "protocol": "openai-chat-completions",
      "baseUrl": "https://newapi.example/v1",
      "apiKeyEnv": "NEWAPI_API_KEY"
    },
    "sub2api": {
      "protocol": "anthropic-messages",
      "modelCatalog": "openai",
      "baseUrl": "https://sub2api.example/v1",
      "apiKeyEnv": "SUB2API_API_KEY"
    },
    "local": {
      "baseUrl": "http://localhost:11434/v1",
      "requiresAuth": false
    }
  },
  "maxParallelWriters": 2,
  "maxRepairAttempts": 4,
  "projectCommands": [
    "npm run typecheck",
    "npm test"
  ],
  "agents": {
    "scout": { "provider": "local", "model": "fast-model", "thinking": "low" },
    "architect": { "provider": "openai", "model": "reasoning-model", "thinking": "high" },
    "backend": { "provider": "openrouter", "model": "coding-model", "thinking": "high" },
    "frontend": { "provider": "openrouter", "model": "ui-model", "thinking": "high" },
    "reviewer": { "provider": "openai", "model": "reasoning-model", "thinking": "high" }
  }
}
```

Interactive routing can be changed without editing the file:

```text
/provider                        select a Provider; authenticate when required
/provider openai oauth           ChatGPT browser OAuth; no API key entry
/provider openai api-key         paste an existing OpenAI API key
/model [query]                   repeatedly choose model and target; Esc finishes
/route                           repeatedly choose model and Agent role; Esc finishes
/route architect openai reasoning-model   direct form
/routing
```

`/provider` is the only interactive Provider command. With no argument it opens the Provider selector; with an ID it selects that Provider and authenticates only when required. For OpenAI, **Sign in with ChatGPT** starts OAuth with PKCE, opens `auth.openai.com`, waits on `http://localhost:1455/auth/callback`, validates the returned state, exchanges the authorization code, and saves the resulting OAuth session. Nothing is pasted into the terminal. The direct `api-key` method remains available through `/provider openai api-key`.

ChatGPT OAuth and Platform API-key authentication are separate request paths. OAuth uses the public Codex OAuth flow and sends OpenAI requests to the ChatGPT Codex Responses backend with the selected ChatGPT account; API keys continue to use the configured Platform-compatible endpoint. VEX implements this flow itself and does not invoke OpenCode/Codex or import either application's credential cache. Access, refresh, and ID tokens are stored only in `~/.vex/auth.json`, refreshed automatically before expiry, and protected with user-only file permissions where the operating system supports them. Treat that file as a secret. Keyless Providers such as Ollama need no credential, environment credentials are detected, and `/logout` removes only credentials saved by VEX.

### Provider and model-catalog contract

VEX selects transport from the Provider profile rather than from a hard-coded vendor name:

| `protocol` | Generation request | Authentication |
| --- | --- | --- |
| `openai-chat-completions` | `POST <baseUrl>/chat/completions` | `Authorization: Bearer ...` |
| `anthropic-messages` | `POST <baseUrl>/messages` | `x-api-key` plus `anthropic-version` |

The independent `modelCatalog` setting defines discovery: `openai` calls `GET <baseUrl>/models` and reads every `data[].id`; `anthropic` calls the same resource with `after_id` pagination and native Anthropic headers. It defaults from `protocol`, but can be overridden—for example, a Sub2API profile can generate through native Messages while listing models through its OpenAI-compatible catalog. `VEX_OPENAI_CODEX_CLIENT_VERSION` is an advanced override for the ChatGPT catalog capability query; it is intentionally separate from the VEX package version.

OpenAI ChatGPT OAuth is the one intentional exception: it discovers and runs Codex models through the authenticated ChatGPT backend. The built-in profiles cover OpenAI, Anthropic, DeepSeek, OpenRouter, and Ollama. NewAPI and Sub2API are deployment-specific, so configure their own `baseUrl`; use `openai-chat-completions` for their OpenAI-compatible entrance or `anthropic-messages` when the gateway exposes native Claude Messages. No VEX adapter code is copied from those projects.

### Network proxy

VEX applies one proxy decision to OAuth token exchange, token refresh, model discovery, ChatGPT Responses, and compatible Provider requests. Resolution order is `VEX_PROXY`, `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY`, then the enabled Windows user system proxy. This lets VEX follow the same v2rayN HTTP or mixed listener used by the browser instead of sending the post-browser OAuth exchange directly. Loopback destinations such as the OAuth callback and local Ollama are always direct; `VEX_NO_PROXY` and `NO_PROXY` add more bypasses. Proxy credentials are never printed.

```powershell
# Usually unnecessary when v2rayN has "Set system proxy" enabled.
$env:VEX_PROXY = "http://127.0.0.1:10808"
vex provider openai oauth

# Force a direct connection or add bypass hosts.
$env:VEX_PROXY = "direct"
$env:VEX_NO_PROXY = "localhost,127.0.0.1,.internal.example"
```

Only HTTP and HTTPS proxy URLs are accepted. For v2rayN, select its HTTP or mixed port rather than a SOCKS-only port. Proxy routing changes the network path but does not change OpenAI account, workspace, or regional eligibility decisions.

`/model` and interactive `/models` load every authenticated or keyless Provider concurrently and present a two-pane selector: Providers remain visible on the left and the active Provider's live model catalog appears on the right. Both panes accept mouse clicks and wheel scrolling; keyboard navigation and type-to-filter remain available. `/models <provider>` narrows the selector to one catalog, while `/model <query>` seeds its search instead of silently accepting an arbitrary ID. After model selection, a second picker assigns it to the session default or a specific fixed Agent role. Catalog failures stay attached to their Provider without hiding successful catalogs, and remote metadata supplies display names, ownership, context limits, and capability hints when available. `/route` follows the same model-first flow, while `/route <role> <provider> <model>` and `--model <id>` remain explicit forms for automation. Secrets are never written to run state or Agent prompts. `VEX_PROVIDER`, `VEX_MODEL`, `VEX_BASE_URL`, `VEX_API_KEY_ENV`, `VEX_PROXY`, and `VEX_MAX_PARALLEL_WRITERS` provide process-level overrides.

## Fixed team workflow

1. Scout reads the repository and returns evidence.
2. Architect creates bounded Backend, Frontend, and Test Engineer assignments.
3. VEX validates the manifest, dependency graph, allowed paths, base commit, commands, and role hashes. Invalid structured plans are returned to Architect with the exact validation error for a bounded correction retry.
4. The CLI displays the complete plan and waits for confirmation. No writer worktree exists yet.
5. Backend and Frontend run in isolated worktrees according to dependencies and concurrency.
6. VEX integrates commits deterministically, then runs Test Engineer and trusted project commands.
7. Reviewer and optional Security Reviewer inspect the clean integration.
8. Findings return to the original owner's existing VEX session. Before each repair, its managed worktree is synchronized to the latest integration HEAD, so later Agents always observe earlier repairs. Verification and review repeat.
9. The run stops at `awaiting-merge`. `vex diff` is available for inspection.
10. `vex merge` alone verifies the source workspace and applies the approved integration—fast-forwarding Git repositories or copying the reviewed diff into ordinary directories.

Every Agent has a persisted lifecycle rather than an inferred phase:

| Lifecycle | Stored status | Meaning |
| --- | --- | --- |
| Not started | `pending` | No attempt has begun. |
| Waiting | `waiting` + `waitingFor` | The Agent is gated by discovery, approval, dependencies, verification, or a repair turn. |
| Working | `running` | A model/tool attempt is active. |
| Delivered | `completed` | A structural `team_yield` was accepted and its delivery was recorded. |

`skipped`, `blocked`, `failed`, and `aborted` remain explicit exceptional terminal states. Each transition records `statusChangedAt`, emits a run event, and is validated by the Agent state machine. The dashboard and non-TTY status line show all Agents—including not-started and waiting Agents—instead of hiding them. A transient Provider interruption is retried only when the Agent left the same clean HEAD; the bounded retry is persisted as `working → waiting → working`, while dirty or explicit failures stop immediately. Before a successful writer checkpoint, VEX removes only known dependency/cache directories that Git proves contain no tracked files, preventing generated installs from becoming delivery artifacts. Atomic run-state replacement also uses bounded backoff for transient Windows file-lock errors, preserving the previous complete state until replacement succeeds.

Every Provider request is counted even when it fails or omits a usage object. When the Provider reports usage, VEX records input, output, cached-input, reasoning, and total Tokens, then aggregates them independently by Agent, Provider, and Provider/model. `reportedRequests/requests` makes incomplete Provider reporting explicit: for example, `3/4 calls reported` means one call is included in the request count but its Token count is unknown rather than assumed to be zero. Use `/usage [run-id]` or `vex usage [run-id]`; add `--json` for the persisted schema. Read-only technical reviews store the same accounting for Scout and Reviewer under their review artifact directory.

VEX's native agent runtime implements `read`, `ls`, `find`, `grep`, `bash`, `edit`, `write`, scoped single-file `delete`, and structural `team_yield`. Read-only roles are checked against Git before and after every turn. Writer edits are checked against manifest paths both at tool time and integration time. Agent prompts expose the isolated worktree, not the original workspace or run-artifact path. Shell commands reject absolute paths and traversal outside that worktree. Secret files and credential environment variables are hidden from Agent tools; network, destructive, publishing, credential, direct Git mutation, and direct shell file-writing commands are blocked. Test Engineer must restore the exact original bytes of any tracked fixture changed at runtime and verify a clean ownership boundary before delivery.

## Run artifacts

```text
Git:       .git/vex/runs/<run-id>/
Directory: .vex/runs/<run-id>/
  state.json
  manifest.json
  scout-report.json
  role-definition-hashes.json
  command-results.json
  review-cycles.json
  findings.json
  events.json
  usage.json
  prompts/<role>.md
  sessions/<role>/history.json
  logs/<role>-<attempt>.jsonl
  results/<role>-<attempt>.json
  changes/<role>-<attempt>.json
```

Git workspace worktrees live beside the repository under `.vex-worktrees/`. Directory-mode managed repositories and worktrees live under `~/.vex/workspaces/`. Failed and aborted worktrees remain inspectable until resume or cleanup.

## Development

```powershell
npm.cmd install
npx.cmd --yes bun run check
npm.cmd pack --dry-run
```

See [docs/architecture.md](docs/architecture.md) for the native runtime and state-machine design. VEX is licensed under Apache-2.0.
