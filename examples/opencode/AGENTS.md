# opencode

AI chat agent that delegates coding tasks to an autonomous OpenCode agent running inside an isolated sandbox container. The user describes what they want built, and the OpenCode agent handles all file operations, shell commands, and tooling.

## Architecture

```
Browser (React)
├── Chat panel                 ← WebSocket via useAgent / useAgentChat
│
SandboxChatAgent (Durable Object, AIChatAgent)
├── Single `opencode` tool     ← delegates to OpencodeSession
├── File watcher (inotify → broadcast)
└── R2 backup / restore (FS + session state)
│
src/opencode/                  ← Extractable library
├── session.ts                 ← OpencodeSession: lifecycle, run, observe, restore
├── stream.ts                  ← SSE→UIMessage accumulator
├── providers.ts               ← Provider config (Anthropic, OpenAI, CF AI)
├── backup.ts                  ← Backup/restore: sandbox FS + session state
├── file-watcher.ts            ← File change observation
├── types.ts                   ← Shared types
└── index.ts                   ← Public API
│
Sandbox Container (Durable Object + Container)
├── docker.io/cloudflare/sandbox:0.8.0-opencode
├── Node.js, Bun, Python, git, standard Unix tools
├── OpenCode server on port 4096
└── Web service ports 8000-8005
```

## Files

| File | Purpose |
|------|---------|
| `src/server.ts` | `SandboxChatAgent` DO — thin agent with single `opencode` tool, delegates to library |
| `src/client.tsx` | React app — chat-only UI with message input and streaming responses |
| `src/client/chat-messages.tsx` | Message rendering + OpenCode sub-conversation display |
| `src/opencode/session.ts` | `OpencodeSession` — manages sandbox lifecycle, OpenCode server/client, one-shot runs |
| `src/opencode/stream.ts` | `OpencodeStreamAccumulator` — translates OpenCode SSE events into `UIMessage[]` |
| `src/opencode/providers.ts` | Provider config builders for Anthropic, OpenAI, Cloudflare Workers AI |
| `src/opencode/backup.ts` | Backup/restore: sandbox FS + OpenCode session state |
| `src/opencode/file-watcher.ts` | `FileWatcher` — observes /workspace changes via inotify |
| `src/opencode/types.ts` | `OpencodeRunOutput`, `ProviderCredentials`, `OpencodeSessionState`, etc. |
| `src/opencode/index.ts` | Public API re-exports |
| `wrangler.jsonc` | Worker config — containers, DOs, R2, AI binding, assets |
| `Dockerfile` | Extends `sandbox:0.8.0-opencode`, exposes ports 4096, 8000-8005 |

## Key patterns

### OpenCode delegation

The agent has a single tool — `opencode` — which sends a prompt to an autonomous OpenCode agent running inside the sandbox container. The `OpencodeSession` class manages the full lifecycle:

1. **Start**: Wake sandbox, detect provider, start OpenCode server, restore previous state
2. **Run**: Create a session, fire an async prompt, stream SSE events back as `UIMessage[]` snapshots
3. **Observe**: The `OpencodeStreamAccumulator` translates SSE events into AI SDK-native parts (text, dynamic-tool)
4. **Backup**: After each run, backup the sandbox FS + session state to R2/DO storage

### Provider auto-detection

The library auto-detects which AI provider to use based on available environment variables:
- `ANTHROPIC_API_KEY` → Anthropic (Claude)
- `OPENAI_API_KEY` → OpenAI (GPT-4)
- `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_KEY` → Cloudflare Workers AI

Explicit credentials can also be passed to `OpencodeSession.start()`.

### Session model

Each chat session uses a base32-encoded UUID as its identifier. This maps 1:1 to a sandbox container and an OpenCode session. Starting a new session provisions a fresh sandbox.

### Backup / restore

Workspace persistence across container eviction uses `sandbox.createBackup()` / `sandbox.restoreBackup()` with handles stored in DO SQLite storage. The backup also includes OpenCode session state (session ID, provider, in-flight run status).

On restore, the agent reconnects the OpenCode client and includes context about any long-running processes that may need restarting.

### File watcher

Uses `sandbox.watch()` with inotify to stream filesystem changes, broadcast as `file-change` ServerMessages. Starts on first client connect, stops when all disconnect.

## Ports

| Port | Use |
|------|-----|
| 3000 | **Reserved** — sandbox control plane, never use |
| 4096 | OpenCode server (internal) |
| 8000-8005 | Available for web services started by the agent |

## Environment variables

Set in `.env` for local development (see `.env.example`):

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic provider credentials |
| `OPENAI_API_KEY` | OpenAI provider credentials |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Workers AI provider |
| `CLOUDFLARE_API_KEY` | Cloudflare Workers AI provider |
| `R2_ACCESS_KEY_ID` | Optional — R2 backup persistence |
| `R2_SECRET_ACCESS_KEY` | Optional — R2 backup persistence |

## Run locally

```bash
npm install
npm start     # requires Docker running
```

First run builds the container image (2-3 minutes).
