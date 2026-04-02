// ── Public API ───────────────────────────────────────────────────────

export { OpencodeSession } from "./session";
export { FileWatcher } from "./file-watcher";
export { OpencodeStreamAccumulator } from "./stream";
export {
  resolveProvider,
  detectProvider,
  describeRequiredEnvVars,
  getProviderDisplayName
} from "./providers";
export { backupSession, restoreSession, updateSessionState } from "./backup";

// ── Re-exported types ────────────────────────────────────────────────

export type {
  OpencodeRunOutput,
  OpencodeRunOptions,
  OpencodeSessionState,
  ProviderID,
  ProviderCredentials,
  ResolvedProvider,
  ServerMessage,
  FileChange,
  FileDiff,
  Diagnostic,
  ProcessInfo,
  Todo
} from "./types";
export type { FileChangeCallback } from "./file-watcher";
export type { OpenCodeSSEEvent } from "./stream";
export type { RestoreResult } from "./backup";
