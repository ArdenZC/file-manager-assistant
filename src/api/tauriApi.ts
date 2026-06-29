import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSettings,
  DashboardStats,
  ExecuteOperationRequest,
  ExecuteOperationResult,
  FileLibraryFilters,
  FileQueryResult,
  FileRecord,
  LibraryScope,
  OperationLog,
  OperationPreview,
  OperationPreviewResult,
  RestoreMovesResult,
  Rule,
  RuleExecutionMode
} from "../types/domain";
import type { View } from "../types/ui";
import type { SearchNavigatePayload } from "../utils/searchNavigation";

export interface ScannedEntry {
  path: string;
  name: string;
  extension: string;
  size: number;
  mtime: number;
  isDir: boolean;
  stateCode: number;
}

export interface ScanProgressPayload {
  root: string;
  scanned: number;
  files: number;
  directories: number;
  skipped: number;
  errors: number;
  elapsedMs: number;
}

export interface ScanBatchPayload {
  root: string;
  batchIndex: number;
  entries: ScannedEntry[];
  progress: ScanProgressPayload;
}

export type ScanSummary = ScanProgressPayload;

export interface OperationProgressPayload {
  kind: "execute" | "restore";
  batchId: string;
  processed: number;
  total: number;
  currentPath: string;
}

export interface GlobalHotkeyErrorPayload {
  message: string;
}

export interface GlobalHotkeyStatus {
  accelerator: string;
  registered: boolean;
  error: string | null;
}

export interface RuleExecutionSummary {
  scanned: number;
  updated: number;
  skipped: number;
  needsConfirmation: number;
}

export interface TauriSearchFileResult {
  id: string;
  path: string;
  name: string;
  extension: string;
  size: number;
  mtime: number;
  isDir: boolean;
  stateCode: number;
  rank: number;
}

type EventHandler<T> = (payload: T, event: Event<T>) => void;

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

function listenTo<T>(eventName: string, handler: EventHandler<T>): Promise<UnlistenFn> {
  return listen<T>(eventName, (event) => handler(event.payload, event));
}

export const tauriApi = {
  getPagedFiles(
    limit = 50,
    offset = 0,
    query?: string,
    scope?: LibraryScope,
    filters?: FileLibraryFilters
  ): Promise<FileQueryResult> {
    const normalizedQuery = query?.trim();
    return invokeCommand<FileQueryResult>("get_paged_files", {
      limit,
      offset,
      query: normalizedQuery ? normalizedQuery : null,
      scope: scope ?? null,
      filter: filters ?? null
    });
  },

  getStatsSummary(scope?: LibraryScope): Promise<DashboardStats> {
    return invokeCommand<DashboardStats>("get_stats_summary", { scope: scope ?? null });
  },

  searchFiles(query: string, limit = 12, scope?: LibraryScope): Promise<FileRecord[]> {
    return invokeCommand<FileRecord[]>("search_files", { query, limit, scope: scope ?? null });
  },

  startScan(path: string, includeEntries = false): Promise<ScanSummary> {
    return invokeCommand<ScanSummary>("scan_directory", { path, includeEntries });
  },

  cancelScan(): Promise<void> {
    return invokeCommand<void>("cancel_scan");
  },

  executeMoves(operations: OperationPreview[]): Promise<ExecuteOperationResult> {
    const request: ExecuteOperationRequest = { operations };
    return invokeCommand<ExecuteOperationResult>("execute_moves", { request });
  },

  restoreMoves(logs: OperationLog[]): Promise<RestoreMovesResult> {
    return invokeCommand<RestoreMovesResult>("restore_moves", { request: { logs } });
  },

  cancelOperations(): Promise<void> {
    return invokeCommand<void>("cancel_operations");
  },

  getOperationLogs(limit = 500): Promise<OperationLog[]> {
    return invokeCommand<OperationLog[]>("get_operation_logs", { limit });
  },

  getOperationPreviewsForScope(
    scope: LibraryScope,
    filters?: FileLibraryFilters,
    limit?: number,
    offset?: number
  ): Promise<OperationPreviewResult> {
    return invokeCommand<OperationPreviewResult>("get_operation_previews_for_scope", {
      scope,
      filter: filters ?? null,
      limit,
      offset
    });
  },

  revealInFolder(path: string): Promise<void> {
    return invokeCommand<void>("reveal_in_folder", { path });
  },

  executeRulesOnInbox(rules: Rule[]): Promise<RuleExecutionSummary> {
    return invokeCommand<RuleExecutionSummary>("execute_rules_on_inbox", { rules });
  },

  executeRulesForPaths(paths: string[], rules: Rule[]): Promise<RuleExecutionSummary> {
    return invokeCommand<RuleExecutionSummary>("execute_rules_for_paths", { paths, rules });
  },

  executeRulesForScope(
    scope: LibraryScope,
    rules: Rule[],
    mode: RuleExecutionMode = "inbox_only"
  ): Promise<RuleExecutionSummary> {
    return invokeCommand<RuleExecutionSummary>("execute_rules_for_scope", { scope, rules, mode });
  },

  getUserRules(): Promise<Rule[]> {
    return invokeCommand<Rule[]>("get_user_rules");
  },

  saveUserRule(rule: Rule): Promise<Rule> {
    return invokeCommand<Rule>("save_user_rule", { rule });
  },

  deleteUserRule(id: string): Promise<boolean> {
    return invokeCommand<boolean>("delete_user_rule", { id });
  },

  getSettings(): Promise<AppSettings> {
    return invokeCommand<AppSettings>("get_settings");
  },

  saveSettings(settings: AppSettings): Promise<AppSettings> {
    return invokeCommand<AppSettings>("save_settings", { settings });
  },

  getGlobalHotkeyStatus(): Promise<GlobalHotkeyStatus | null> {
    return invokeCommand<GlobalHotkeyStatus | null>("get_global_hotkey_status");
  },

  registerGlobalSearchHotkey(accelerator: string): Promise<GlobalHotkeyStatus> {
    return invokeCommand<GlobalHotkeyStatus>("register_global_search_hotkey", { accelerator });
  },

  quitApp(): Promise<void> {
    return invokeCommand<void>("quit_app");
  },

  activateSearchResult(view: View, fileId: string | null): Promise<void> {
    return invokeCommand<void>("activate_search_result", { view, fileId });
  },

  initDatabase(): Promise<void> {
    return invokeCommand<void>("init_db");
  },

  insertFile(file: Pick<FileRecord, "id" | "path" | "name" | "extension" | "size"> & {
    mtime: number;
    isDir: boolean;
    stateCode: number;
  }): Promise<void> {
    return invokeCommand<void>("insert_file", { file });
  },

  removeFilesByPaths(paths: string[]): Promise<number> {
    return invokeCommand<number>("remove_files_by_paths", { paths });
  },

  // Backed by the legacy remove_files_by_paths command; the backend now marks
  // records stale instead of deleting index rows.
  markFilesStaleByPaths(paths: string[]): Promise<number> {
    return invokeCommand<number>("remove_files_by_paths", { paths });
  },

  upsertFilesByPaths(paths: string[]): Promise<number> {
    return invokeCommand<number>("upsert_files_by_paths", { paths });
  },

  onScanProgress(handler: EventHandler<ScanProgressPayload>): Promise<UnlistenFn> {
    return listenTo("scan-progress", handler);
  },

  onScanBatch(handler: EventHandler<ScanBatchPayload>): Promise<UnlistenFn> {
    return listenTo("scan-batch", handler);
  },

  onScanComplete(handler: EventHandler<ScanSummary>): Promise<UnlistenFn> {
    return listenTo("scan-complete", handler);
  },

  onScanError(handler: EventHandler<{ root: string; path: string; message: string }>): Promise<UnlistenFn> {
    return listenTo("scan-error", handler);
  },

  onOperationProgress(handler: EventHandler<OperationProgressPayload>): Promise<UnlistenFn> {
    return listenTo("operation-progress", handler);
  },

  onSearchNavigate(handler: EventHandler<SearchNavigatePayload>): Promise<UnlistenFn> {
    return listenTo("search-navigate", handler);
  },

  onGlobalHotkeyRegistrationFailed(handler: EventHandler<GlobalHotkeyErrorPayload>): Promise<UnlistenFn> {
    return listenTo("global-hotkey-registration-failed", handler);
  }
};

export type TauriApi = typeof tauriApi;
