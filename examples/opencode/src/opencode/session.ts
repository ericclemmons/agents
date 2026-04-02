import { getSandbox, parseSSEStream, type Sandbox } from "@cloudflare/sandbox";
import {
  createOpencode,
  type OpencodeServer
} from "@cloudflare/sandbox/opencode";
import type { OpencodeClient } from "@opencode-ai/sdk/v2/client";

import type {
  ProviderCredentials,
  ResolvedProvider,
  OpencodeRunOutput,
  OpencodeRunOptions,
  OpencodeSessionState
} from "./types";
import {
  resolveProvider,
  detectProvider,
  describeRequiredEnvVars
} from "./providers";
import { OpencodeStreamAccumulator } from "./stream";
import { FileWatcher, type FileChangeCallback } from "./file-watcher";
import {
  backupSession,
  restoreSession,
  updateSessionState,
  type RestoreResult
} from "./backup";

// ── OpencodeSession ──────────────────────────────────────────────────

/**
 * Manages the full lifecycle of an OpenCode agent session inside a
 * sandbox container. This is the main entry point for the library.
 *
 * Responsibilities:
 * - Sandbox provisioning and lifecycle
 * - OpenCode server/client startup and credential registration
 * - One-shot runs (prompt → async generator of snapshots)
 * - File change observation during runs
 * - Backup/restore of sandbox FS + OpenCode session state
 * - Resumption of in-flight runs after eviction
 *
 * Usage:
 * ```ts
 * const session = new OpencodeSession(env.Sandbox, agentName);
 * await session.start(env, storage);
 *
 * for await (const snapshot of session.run("Build a TODO app")) {
 *   // snapshot is OpencodeRunOutput with UIMessage[] etc.
 * }
 * ```
 */
export class OpencodeSession<S extends Sandbox<unknown> = Sandbox<unknown>> {
  private sandboxBinding: DurableObjectNamespace<S>;
  private sandboxName: string;
  private _sandbox: S | null = null;
  private server: OpencodeServer | null = null;
  private client: OpencodeClient | null = null;
  private provider: ResolvedProvider | null = null;
  private _started = false;
  private _currentSessionId: string | null = null;
  private _runInFlight = false;
  private _runPrompt: string | null = null;
  private _fileWatcher = new FileWatcher();

  constructor(sandboxBinding: DurableObjectNamespace<S>, sandboxName: string) {
    this.sandboxBinding = sandboxBinding;
    this.sandboxName = sandboxName;
  }

  /** The underlying sandbox instance. Available after `start()`. */
  get sandbox(): S {
    if (!this._sandbox) {
      this._sandbox = getSandbox(this.sandboxBinding, this.sandboxName);
    }
    return this._sandbox;
  }

  /** Whether the session has been started. */
  get isStarted(): boolean {
    return this._started;
  }

  /** The current OpenCode session ID, if any. */
  get currentSessionId(): string | null {
    return this._currentSessionId;
  }

  /** Whether a run is currently in-flight. */
  get isRunning(): boolean {
    return this._runInFlight;
  }

  /** Whether the file watcher is active. */
  get isWatching(): boolean {
    return this._fileWatcher.isRunning;
  }

  // ── Lifecycle ────────────────────────────────────────────────────

  /**
   * Start the session: wake the sandbox, detect/resolve the provider,
   * start the OpenCode server, and restore any previous state.
   *
   * @param env - Environment bindings (must include provider credentials)
   * @param storage - DO storage for backup/restore
   * @param credentials - Optional explicit provider credentials; if not
   *   provided, auto-detects from env vars.
   */
  async start(
    env: Record<string, unknown>,
    storage: DurableObjectStorage,
    credentials?: ProviderCredentials
  ): Promise<RestoreResult> {
    if (this._started) return { fsRestored: false, sessionState: null };
    this._started = true;

    // Wake the container
    await this.sandbox.exec("true");

    // Resolve provider
    const creds = credentials ?? detectProvider(env);
    if (!creds) {
      throw new Error(
        `No provider credentials found.\n${describeRequiredEnvVars()}`
      );
    }
    this.provider = resolveProvider(creds);

    // Restore previous state (before starting OpenCode so it boots
    // into an already-populated workspace)
    const result = await restoreSession(this.sandbox, storage);

    // Start OpenCode server + client
    await this.ensureOpencode();

    if (result.sessionState) {
      this._currentSessionId = result.sessionState.sessionId;
      this._runInFlight = result.sessionState.runInFlight;
      this._runPrompt = result.sessionState.runPrompt ?? null;
    }

    return result;
  }

  /**
   * Ensure the OpenCode server + client are running.
   * Reuses across invocations.
   */
  private async ensureOpencode(): Promise<OpencodeClient> {
    if (this.client && this.server) {
      return this.client;
    }

    if (!this.provider) {
      throw new Error("Provider not resolved — call start() first");
    }

    const { client, server } = await createOpencode<OpencodeClient>(
      this.sandbox,
      {
        directory: "/workspace",
        config: this.provider.config,
        env: this.provider.env,
        user: "opencode"
      }
    );

    // Register credentials in OpenCode's credential store
    await client.auth.set(this.provider.auth);

    this.server = server;
    this.client = client;
    return client;
  }

  // ── One-shot run ─────────────────────────────────────────────────

  /**
   * Run a one-shot prompt against the OpenCode agent. Returns an async
   * generator that yields `OpencodeRunOutput` snapshots as the agent
   * works — each containing the growing `UIMessage[]` sub-conversation.
   *
   * The final yield has `status: "complete"` or `status: "error"`.
   */
  async *run(
    prompt: string,
    options?: OpencodeRunOptions
  ): AsyncGenerator<OpencodeRunOutput> {
    const client = await this.ensureOpencode();

    // Create a new OpenCode session for this run
    const session = await client.session.create({
      title: prompt.slice(0, 80)
    });

    if (!session.data) {
      yield {
        status: "error" as const,
        sessionId: "",
        messages: [],
        error: `Failed to create OpenCode session: ${JSON.stringify(session.error ?? session)}`
      };
      return;
    }

    const sessionId = session.data.id;
    this._currentSessionId = sessionId;
    this._runInFlight = true;
    this._runPrompt = prompt;

    const accumulator = new OpencodeStreamAccumulator(sessionId);

    // Yield initial state
    yield accumulator.getSnapshot();

    // Open SSE event stream
    const server = this.server;
    if (!server) {
      yield {
        status: "error" as const,
        sessionId,
        messages: [],
        error: "OpenCode server not running"
      };
      return;
    }

    const sseResp = await this.sandbox.containerFetch(
      new Request(`${server.url}/event`),
      server.port
    );
    if (!sseResp.ok || !sseResp.body) {
      yield {
        status: "error" as const,
        sessionId,
        messages: [],
        error: `Event stream failed: ${sseResp.status} ${sseResp.statusText}`
      };
      return;
    }

    // Fire the prompt (async — returns immediately while agent works)
    await client.session.promptAsync({
      sessionID: sessionId,
      parts: [{ type: "text" as const, text: prompt }]
    });

    // Stream SSE events with inactivity timeout and periodic backup
    const INACTIVITY_TIMEOUT_MS = 120_000;
    const THROTTLE_MS = 200;
    const BACKUP_INTERVAL_MS = options?.backupIntervalMs ?? 30_000;
    let lastYieldAt = Date.now();
    let lastBackupAt = Date.now();
    let backupInFlight = false;

    try {
      for await (const ev of parseSSEStream<{
        type: string;
        properties?: Record<string, unknown>;
      }>(sseResp.body, options?.signal)) {
        // Inactivity watchdog
        const inactivityTimer = setTimeout(() => {
          try {
            sseResp.body!.cancel();
          } catch {
            /* ignore */
          }
        }, INACTIVITY_TIMEOUT_MS);

        // Process event
        accumulator.processEvent(ev);

        // Yield throttled snapshots
        const now = Date.now();
        if (accumulator.dirty && now - lastYieldAt >= THROTTLE_MS) {
          yield accumulator.getSnapshot();
          lastYieldAt = now;
        }

        // Periodic backup (fire-and-forget, non-blocking)
        if (
          options?.storage &&
          now - lastBackupAt >= BACKUP_INTERVAL_MS &&
          !backupInFlight
        ) {
          lastBackupAt = now;
          backupInFlight = true;
          this.backup(options.storage)
            .catch((err) =>
              console.warn("[opencode/session] Periodic backup failed:", err)
            )
            .finally(() => {
              backupInFlight = false;
            });
        }

        // Check for terminal states
        if (
          accumulator.status === "complete" ||
          accumulator.status === "error"
        ) {
          clearTimeout(inactivityTimer);
          break;
        }

        clearTimeout(inactivityTimer);
      }
    } catch (err) {
      if (accumulator.status === "working") {
        accumulator.processEvent({
          type: "session.error",
          properties: {
            sessionID: sessionId,
            error: err instanceof Error ? err.message : "Event stream failed"
          }
        });
      }
    }

    this._runInFlight = false;
    this._runPrompt = null;

    // Run completion callback (typically backup) — never let it fail the run
    if (options?.onComplete) {
      try {
        await options.onComplete();
      } catch (err) {
        console.warn("[opencode/session] onComplete callback failed:", err);
      }
    }

    // Final yield
    yield accumulator.getSnapshot();
  }

  // ── File watching ────────────────────────────────────────────────

  /**
   * Start watching /workspace for file changes.
   * The callback receives JSON-serialized ServerMessage strings.
   */
  startFileWatcher(onEvent: FileChangeCallback): void {
    if (!this._started) return;
    this._fileWatcher.start(this.sandbox, onEvent);
  }

  /** Stop the file watcher. */
  stopFileWatcher(): void {
    this._fileWatcher.stop();
  }

  // ── Backup ───────────────────────────────────────────────────────

  /**
   * Create a backup of the sandbox workspace and OpenCode session state.
   */
  async backup(storage: DurableObjectStorage): Promise<void> {
    const sessionState: OpencodeSessionState | undefined =
      this._currentSessionId && this.provider
        ? {
            sessionId: this._currentSessionId,
            providerId: this.provider.id,
            runInFlight: this._runInFlight,
            runPrompt: this._runPrompt ?? undefined
          }
        : undefined;

    await backupSession(this.sandbox, storage, sessionState);
  }

  /**
   * Update just the session state in DO storage (without a full FS backup).
   */
  async updateState(storage: DurableObjectStorage): Promise<void> {
    if (!this._currentSessionId || !this.provider) return;

    await updateSessionState(storage, {
      sessionId: this._currentSessionId,
      providerId: this.provider.id,
      runInFlight: this._runInFlight,
      runPrompt: this._runPrompt ?? undefined
    });
  }

  // ── Resume ───────────────────────────────────────────────────────

  /**
   * Get context about the restored session state, suitable for
   * including in the agent's system prompt or next message.
   *
   * Returns null if there's nothing notable to report.
   */
  getRestoreContext(): string | null {
    if (!this._runInFlight || !this._runPrompt) return null;

    return [
      "⚠️ The sandbox was restored from a backup.",
      `A previous OpenCode run was in-flight with prompt: "${this._runPrompt}"`,
      "Any long-running processes (dev servers, watchers, etc.) that were",
      "running in the sandbox may need to be restarted.",
      "The OpenCode session has been reconnected."
    ].join(" ");
  }
}
