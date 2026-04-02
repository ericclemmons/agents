import {
  getSandbox,
  parseSSEStream,
  type ISandbox,
  type FileWatchSSEEvent
} from "@cloudflare/sandbox";
import type { ServerMessage } from "./types";

/**
 * Callback type for file change events.
 * Receives a serialized ServerMessage JSON string.
 */
export type FileChangeCallback = (msg: string) => void;

/**
 * Manages a filesystem watcher on /workspace inside the sandbox.
 * Can be started with a callback that receives file-change events.
 *
 * Designed to be used standalone — not tied to any specific agent
 * broadcast mechanism. The consumer provides the callback.
 */
export class FileWatcher {
  private controller: AbortController | null = null;
  private running = false;

  get isRunning(): boolean {
    return this.running;
  }

  /**
   * Start watching /workspace for filesystem changes. Calls `onEvent`
   * with a JSON-serialized ServerMessage for each change event.
   * Runs as a background async loop — call `stop()` to tear down.
   */
  start(sandbox: ISandbox, onEvent: FileChangeCallback): void {
    if (this.running) return;
    this.running = true;

    const controller = new AbortController();
    this.controller = controller;

    (async () => {
      try {
        const stream = await sandbox.watch("/workspace", { recursive: true });

        for await (const event of parseSSEStream<FileWatchSSEEvent>(
          stream,
          controller.signal
        )) {
          if (event.type === "event") {
            const msg: ServerMessage = {
              type: "file-change",
              eventType: event.eventType,
              path: event.path,
              isDirectory: event.isDirectory
            };
            onEvent(JSON.stringify(msg));
          } else if (event.type === "error" || event.type === "stopped") {
            break;
          }
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          console.error("[opencode/file-watcher] Error:", err);
        }
      } finally {
        this.running = false;
        this.controller = null;
      }
    })();
  }

  /** Stop the watcher. Safe to call if not running. */
  stop(): void {
    this.controller?.abort();
    this.running = false;
    this.controller = null;
  }
}
