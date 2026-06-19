import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  DashboardStats,
  ExecuteOperationRequest,
  ExecuteOperationResult,
  FileQueryResult,
  FileRecord,
  OperationLog,
  OperationPreview,
  RestoreMovesResult,
  Rule
} from "../types/domain";

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

export interface RuleExecutionSummary {
  scanned: number;
  updated: number;
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
  getPagedFiles(limit = 50, offset = 0, query?: string): Promise<FileQueryResult> {
    const normalizedQuery = query?.trim();
    return invokeCommand<FileQueryResult>("get_paged_files", {
      limit,
      offset,
      query: normalizedQuery ? normalizedQuery : null
    });
  },

  getStatsSummary(): Promise<DashboardStats> {
    return invokeCommand<DashboardStats>("get_stats_summary");
  },

  searchFiles(query: string, limit = 12): Promise<TauriSearchFileResult[]> {
    return invokeCommand<TauriSearchFileResult[]>("search_files", { query, limit });
  },

  startScan(path: string): Promise<ScanSummary> {
    return invokeCommand<ScanSummary>("scan_directory", { path });
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

  revealInFolder(path: string): Promise<void> {
    return invokeCommand<void>("reveal_in_folder", { path });
  },

  executeRulesOnInbox(rules: Rule[]): Promise<RuleExecutionSummary> {
    return invokeCommand<RuleExecutionSummary>("execute_rules_on_inbox", { rules });
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
  }
};

export type TauriApi = typeof tauriApi;
