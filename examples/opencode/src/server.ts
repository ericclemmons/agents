import { createWorkersAI } from "workers-ai-provider";
import { routeAgentRequest } from "agents";
import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import {
  streamText,
  convertToModelMessages,
  pruneMessages,
  tool,
  stepCountIs
} from "ai";
import { z } from "zod";

import { OpencodeSession } from "./opencode";
import type { OpencodeRunOutput } from "./opencode";

export type { OpencodeRunOutput };
export { Sandbox } from "@cloudflare/sandbox";

// ── Agent ───────────────────────────────────────────────────────────

/**
 * AI Chat Agent that delegates coding tasks to an OpenCode agent
 * running inside a sandbox container.
 *
 * The agent has a single tool — `opencode` — which runs a one-shot
 * prompt against the OpenCode agent and streams back progress as
 * UIMessage snapshots.
 */
export class SandboxChatAgent extends AIChatAgent {
  // ── OpenCode session ─────────────────────────────────────────────

  private _session: OpencodeSession | undefined;
  private _sessionStarted = false;

  private get session(): OpencodeSession {
    if (!this._session) {
      this._session = new OpencodeSession(this.env.Sandbox, this.name);
    }
    return this._session;
  }

  // ── Workspace lifecycle ─────────────────────────────────────────

  maxPersistedMessages = 200;

  /**
   * Ensure the OpenCode session is started: sandbox is awake, provider
   * is resolved, OpenCode server is running, and any previous state
   * has been restored.
   */
  private async ensureSession(): Promise<void> {
    if (this._sessionStarted) return;
    this._sessionStarted = true;

    const result = await this.session.start(
      this.env as unknown as Record<string, unknown>,
      this.ctx.storage
    );

    // Start file watcher (broadcasts to all connected clients)
    this.session.startFileWatcher((msg) => this.broadcast(msg));

    // If there was an in-flight run, log it for context
    if (result.sessionState?.runInFlight) {
      console.log(
        "[agent] Restored session with in-flight run:",
        result.sessionState.runPrompt
      );
    }
  }

  /** Backup helper bound to this session. */
  private doBackup = () => this.session.backup(this.ctx.storage);

  // ── Connection lifecycle ────────────────────────────────────────

  override async onConnect(
    conn: Parameters<AIChatAgent["onConnect"]>[0],
    ctx: Parameters<AIChatAgent["onConnect"]>[1]
  ): Promise<void> {
    await this.ensureSession();
    return super.onConnect(conn, ctx);
  }

  override onClose(
    conn: Parameters<AIChatAgent["onClose"]>[0],
    code: number,
    reason: string,
    wasClean: boolean
  ): void {
    super.onClose(conn, code, reason, wasClean);

    // Stop the file watcher when no clients remain
    let clientCount = 0;
    for (const _c of this.getConnections()) clientCount++;
    if (clientCount === 0) {
      this.session.stopFileWatcher();
    }
  }

  // ── Chat handler ────────────────────────────────────────────────

  async onChatMessage(
    _onFinish: unknown,
    options?: OnChatMessageOptions
  ): Promise<Response> {
    await this.ensureSession();

    const workersai = createWorkersAI({ binding: this.env.AI });

    // Build system prompt, including restore context if applicable
    const systemParts = [
      "You are a helpful assistant that delegates coding tasks to an autonomous AI coding agent (OpenCode) running in an isolated Linux sandbox.",
      "You have a single tool — `opencode` — which sends a prompt to the OpenCode agent.",
      "The OpenCode agent has full access to the sandbox: it can read/write files, run shell commands, use git, and install packages.",
      "When the user asks you to build, create, modify, or fix code, use the `opencode` tool with a clear, specific prompt.",
      "Include relevant context in your prompt: file paths, technology preferences, port constraints (use ports 8000-8005 only, never port 3000).",
      "After the opencode tool completes, briefly summarize what was done."
    ];

    const restoreContext = this.session.getRestoreContext();
    if (restoreContext) {
      systemParts.push(restoreContext);
    }

    const result = streamText({
      abortSignal: options?.abortSignal,
      model: workersai("@cf/moonshotai/kimi-k2.5", {
        sessionAffinity: this.sessionAffinity
      }),
      system: systemParts.join("\n"),
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
        reasoning: "before-last-message"
      }),
      tools: {
        opencode: tool({
          description: [
            "Delegate a coding task to an autonomous coding agent (OpenCode) running in the sandbox.",
            "Use this for any coding request: building apps, creating files, refactoring, debugging, running commands, etc.",
            "The agent has full shell, file read/write, and tool access inside /workspace.",
            "Each invocation starts a fresh session. The prompt should be self-contained.",
            "IMPORTANT: When running web services, use ports 8000–8005 only. Port 3000 is reserved and must NEVER be used.",
            "Always include this port constraint in the prompt when the task involves a web server or dev server."
          ].join(" "),
          inputSchema: z.object({
            prompt: z
              .string()
              .describe(
                "The coding task description. Be as specific as possible."
              )
          }),
          execute: ({ prompt }, { abortSignal }) =>
            this.session.run(prompt, {
              signal: abortSignal,
              onComplete: this.doBackup,
              storage: this.ctx.storage
            })
        })
      },
      stopWhen: stepCountIs(10)
    });

    return result.toUIMessageStreamResponse();
  }
}

// ── Worker fetch handler ────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env) {
    return (await routeAgentRequest(request, env)) || env.Assets.fetch(request);
  }
} satisfies ExportedHandler<Env>;
