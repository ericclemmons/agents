import type { UIMessage } from "ai";
import type { Config } from "@opencode-ai/sdk/v2";

// ── Run output ───────────────────────────────────────────────────────

/**
 * Output type for every yield of the `opencode` async-generator tool.
 * Preliminary yields carry the growing sub-conversation; the final yield
 * includes the completed conversation and optional summary.
 */
export type OpencodeRunOutput = {
  /** Overall lifecycle status. */
  status: "working" | "complete" | "error";
  /** OpenCode session ID for correlation. */
  sessionId: string;
  /** Sub-conversation messages using AI SDK's native UIMessage format. */
  messages: UIMessage[];
  /** Files edited by the agent during this run. */
  filesEdited: string[];
  /** File system changes observed during this run. */
  fileChanges: FileChange[];
  /** Session diff: file-level diffs produced at the end of the run. */
  diffs: FileDiff[];
  /** LSP diagnostics encountered during the run. */
  diagnostics: Diagnostic[];
  /** Shell processes spawned by the agent during the run. */
  processes: ProcessInfo[];
  /** Todos/tasks tracked by the agent during the run. */
  todos: Todo[];
  /** Final summary text (only on status === "complete"). */
  summary?: string;
  /** Error description (only on status === "error"). */
  error?: string;
};

// ── File events ──────────────────────────────────────────────────────

export type FileChange = {
  file: string;
  event: "add" | "change" | "unlink";
};

export type FileDiff = {
  file: string;
  before: string;
  after: string;
  additions: number;
  deletions: number;
  status?: "added" | "deleted" | "modified";
};

// ── Diagnostic events ─────────────────────────────────────────────────

export type Diagnostic = {
  serverID: string;
  path: string;
};

// ── Process events ────────────────────────────────────────────────────

export type ProcessInfo = {
  id: string;
  command: string;
  args: string[];
  status: "running" | "exited";
  exitCode?: number;
};

// ── Todo events ───────────────────────────────────────────────────────

export type Todo = {
  content: string;
  status: string;
  priority: string;
};

// ── Provider config ──────────────────────────────────────────────────

/** Supported provider identifiers. */
export type ProviderID = "cloudflare-workers-ai" | "anthropic" | "openai";

/**
 * Credentials needed to configure a provider inside the sandbox.
 * Each provider type has its own shape.
 */
export type ProviderCredentials =
  | {
      provider: "cloudflare-workers-ai";
      accountId: string;
      apiKey: string;
    }
  | {
      provider: "anthropic";
      apiKey: string;
    }
  | {
      provider: "openai";
      apiKey: string;
    };

/**
 * Resolved provider configuration: the OpenCode Config to use inside
 * the sandbox, the env vars to inject, and the auth registration call.
 */
export type ResolvedProvider = {
  /** Provider identifier. */
  id: ProviderID;
  /** OpenCode config to pass to `createOpencode()`. */
  config: Config;
  /** Environment variables to inject into the sandbox. */
  env: Record<string, string>;
  /** Auth registration payload for `client.auth.set()`. */
  auth: {
    providerID: string;
    auth: { type: "api"; key: string };
  };
};

// ── Session state (persisted in DO storage) ──────────────────────────

/**
 * Persisted state for an OpenCode session. Stored in DO SQLite storage
 * alongside the sandbox filesystem backup handle.
 */
export type OpencodeSessionState = {
  /** OpenCode session ID (from the SDK). */
  sessionId: string;
  /** Provider used for this session. */
  providerId: ProviderID;
  /** Whether a run was in-flight when the backup was taken. */
  runInFlight: boolean;
  /** The prompt of the in-flight run, if any. */
  runPrompt?: string;
};

// ── Server → client message protocol ─────────────────────────────────

export type ServerMessage = {
  type: "file-change";
  eventType: string;
  path: string;
  isDirectory: boolean;
};

// ── Run options ──────────────────────────────────────────────────────

export type OpencodeRunOptions = {
  /** Abort signal to cancel the run. */
  signal?: AbortSignal;
  /** Callback invoked after each run completes (for backup). */
  onComplete?: () => Promise<void>;
  /** DO storage for periodic mid-run backups. If not provided, no periodic backups occur. */
  storage?: DurableObjectStorage;
  /** Interval in ms between periodic backups during a run (default: 30000). */
  backupIntervalMs?: number;
};
