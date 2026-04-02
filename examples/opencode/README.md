# OpenCode

An AI chat agent that delegates coding tasks to an autonomous [OpenCode](https://opencode.ai) agent running inside an isolated Linux container via the [Sandbox SDK](https://developers.cloudflare.com/sandbox/). Describe what you want built and the agent handles all file operations, shell commands, and tooling — streaming progress back in real time.

## What this demonstrates

- **OpenCode delegation** — hand off any coding task to an autonomous agent inside the container
- **Streaming observation** — watch the agent work in real-time via `UIMessage[]` snapshots
- **Multi-provider support** — auto-detects Anthropic, OpenAI, or Cloudflare Workers AI credentials
- **File watching** — inotify-based filesystem watcher broadcasts changes to the UI
- **Persistent workspace** — files and session state survive container eviction via R2 backup/restore
- **Extractable library** — all OpenCode integration lives in `src/opencode/`, designed for reuse

## File layout

```
src/
  opencode/                    # Extractable library
    session.ts                 # OpencodeSession — lifecycle, run, observe, restore
    stream.ts                  # SSE→UIMessage accumulator
    providers.ts               # Provider config (Anthropic, OpenAI, CF AI)
    backup.ts                  # Backup/restore: sandbox FS + session state
    file-watcher.ts            # File change observation
    types.ts                   # Shared types
    index.ts                   # Public API
  server.ts                    # SandboxChatAgent — thin agent with single `opencode` tool
  client.tsx                   # Chat-only UI
  client/
    chat-messages.tsx          # Message list + OpenCode sub-conversation renderer
    connection-indicator.tsx   # Connection status dot
    mode-toggle.tsx            # Dark/light theme toggle
  index.tsx                    # React entry point
  styles.css                   # Tailwind v4 + Kumo imports
```

## Prerequisites

- [Docker](https://docs.docker.com/desktop/) running locally (required for the sandbox container)
- [Node.js](https://nodejs.org/) 24+
- A Cloudflare account (Workers Paid plan for Containers)

## Run locally

```bash
npm install
npm start
```

> First run builds the Docker container image (2–3 minutes). Subsequent runs are faster.

## Environment variables

Set **one** of the following provider credential sets in `.env` (see `.env.example`):

```bash
# Anthropic (Claude)
ANTHROPIC_API_KEY=your-anthropic-api-key

# OpenAI (GPT-4)
OPENAI_API_KEY=your-openai-api-key

# Cloudflare Workers AI
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_API_KEY=your-api-key
```

For workspace persistence across evictions:

```bash
R2_ACCESS_KEY_ID=your-r2-access-key-id
R2_SECRET_ACCESS_KEY=your-r2-secret-access-key
```

Without R2 credentials, the chat still works — files just won't survive container eviction.

## Deploy

```bash
npm run deploy
```

Then set secrets for production:

```bash
npx wrangler secret put ANTHROPIC_API_KEY  # or OPENAI_API_KEY, or both CF vars
npx wrangler secret put R2_ACCESS_KEY_ID
npx wrangler secret put R2_SECRET_ACCESS_KEY
```

## Key patterns

### Using the OpenCode library

```typescript
import { OpencodeSession } from "./opencode";

// In your agent DO:
const session = new OpencodeSession(env.Sandbox, agentName);
await session.start(env, this.ctx.storage);

// Run a one-shot prompt:
for await (const snapshot of session.run("Build a todo app with React")) {
  // snapshot.status: "working" | "complete" | "error"
  // snapshot.messages: UIMessage[] — the sub-conversation
  // Yield as preliminary tool results for real-time streaming
}

// Backup after changes:
await session.backup(this.ctx.storage);
```

### Provider auto-detection

The library scans environment variables in order: `ANTHROPIC_API_KEY` → `OPENAI_API_KEY` → `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_KEY`. You can also pass explicit credentials:

```typescript
await session.start(env, storage, {
  provider: "anthropic",
  apiKey: env.ANTHROPIC_API_KEY
});
```

### Backup/restore with session state

```typescript
// Persists: sandbox FS + opencode session ID + provider + in-flight run status
await session.backup(this.ctx.storage);

// On restore: reconnects opencode client, provides context about process restart
const result = await session.start(env, storage);
if (result.sessionState?.runInFlight) {
  const context = session.getRestoreContext();
  // Include in next agent message
}
```
