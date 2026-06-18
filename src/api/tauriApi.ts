import { invoke } from "@tauri-apps/api/core";
import { listen, type Event, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  AppSnapshot,
  ExecuteOperationRequest,
  ExecuteOperationResult,
  FileRecord,
  OperationPreview
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

type EventHandler<T> = (payload: T, event: Event<T>) => void;

async function invokeCommand<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  return invoke<T>(command, args);
}

function listenTo<T>(eventName: string, handler: EventHandler<T>): Promise<UnlistenFn> {
  return listen<T>(eventName, (event) => handler(event.payload, event));
}

export const tauriApi = {
  fetchDatabase(): Promise<AppSnapshot> {
    return invokeCommand<AppSnapshot>("fetch_database");
  },

  startScan(path: string): Promise<ScanSummary> {
    return invokeCommand<ScanSummary>("scan_directory", { path });
  },

  executeMoves(operations: OperationPreview[]): Promise<ExecuteOperationResult> {
    const request: ExecuteOperationRequest = { operations };
    return invokeCommand<ExecuteOperationResult>("execute_moves", { request });
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
