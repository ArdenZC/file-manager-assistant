import fs from "node:fs/promises";
import path from "node:path";
import type { ExecuteOperationResult, FileRecord, OperationLog, OperationPreview } from "../types/domain.js";
import { mapWithConcurrency } from "./concurrency.js";
import { safeMoveFile } from "./fileMoves.js";
import { nowIso, randomId } from "./id.js";
import { validateOperationPreview } from "./operationGuards.js";

const EXECUTION_CONCURRENCY = 12;

type PlannedOperation =
  | { kind: "log"; index: number; log: OperationLog }
  | {
      kind: "move";
      index: number;
      file: FileRecord;
      operation: OperationPreview;
      actualOperation: OperationPreview;
      targetPath: string;
      createdAt: string;
    };

type MoveResult = {
  index: number;
  log: OperationLog;
  updatedFile?: FileRecord;
};

export async function executeOperations(
  files: FileRecord[],
  operations: OperationPreview[]
): Promise<ExecuteOperationResult> {
  const batchId = randomId("batch");
  const byId = new Map(files.map((file) => [file.id, file]));
  const reservedTargets = new Set<string>();
  const planned: PlannedOperation[] = [];

  for (const [index, operation] of operations.entries()) {
    const createdAt = nowIso();
    const file = byId.get(operation.fileId);

    if (!file) {
      planned.push({ kind: "log", index, log: makeLog(operation, batchId, "failed", "File record no longer exists", createdAt) });
      continue;
    }

    const validationError = validateOperationPreview(file, operation);
    if (validationError) {
      planned.push({ kind: "log", index, log: makeLog(operation, batchId, "skipped", validationError, createdAt) });
      continue;
    }

    const targetPath = await resolveAvailableTargetPath(operation.target_path, reservedTargets);
    if (!targetPath) {
      planned.push({ kind: "log", index, log: makeLog(operation, batchId, "failed", "No available non-conflicting target path", createdAt) });
      continue;
    }
    reservedTargets.add(normalizeResolvedPath(targetPath));
    planned.push({
      kind: "move",
      index,
      file,
      operation,
      actualOperation: withActualTarget(operation, targetPath),
      targetPath,
      createdAt
    });
  }

  const moveResults = await mapWithConcurrency(
    planned.filter((item): item is Extract<PlannedOperation, { kind: "move" }> => item.kind === "move"),
    EXECUTION_CONCURRENCY,
    executePlannedMove(batchId)
  );
  const moveResultsByIndex = new Map(moveResults.map((result) => [result.index, result]));
  const logs = planned
    .map((item) => item.kind === "log" ? item.log : moveResultsByIndex.get(item.index)?.log)
    .filter((log): log is OperationLog => Boolean(log));
  const updatedFiles = moveResults
    .map((result) => result.updatedFile)
    .filter((file): file is FileRecord => Boolean(file));

  return { logs, updatedFiles, batch_id: batchId };
}

function executePlannedMove(batchId: string) {
  return async function executeMove(planned: Extract<PlannedOperation, { kind: "move" }>): Promise<MoveResult> {
    try {
      await safeMoveFile(planned.operation.source_path, planned.targetPath);
      const nextFile = {
        ...planned.file,
        path: planned.targetPath,
        directory: path.dirname(planned.targetPath),
        name: path.basename(planned.targetPath),
        suggested_action: "Keep" as const,
        suggested_target_path: "",
        suggested_name: path.basename(planned.targetPath),
        requires_confirmation: false,
        last_seen_at: planned.createdAt
      };
      return {
        index: planned.index,
        log: makeLog(planned.actualOperation, batchId, "success", null, planned.createdAt),
        updatedFile: nextFile
      };
    } catch (error) {
      return {
        index: planned.index,
        log: makeLog(planned.operation, batchId, "failed", readableError(error), planned.createdAt)
      };
    }
  };
}

function makeLog(
  operation: OperationPreview,
  batchId: string,
  status: OperationLog["status"],
  error: string | null,
  createdAt: string
): OperationLog {
  const success = status === "success";
  return {
    id: randomId("log"),
    batch_id: batchId,
    operation_type: operation.operation_type,
    source_path: operation.source_path,
    target_path: operation.target_path,
    old_name: operation.old_name,
    new_name: operation.new_name,
    status,
    error_message: error,
    created_at: createdAt,
    can_undo: success,
    path_before: operation.source_path,
    path_after: operation.target_path,
    name_before: operation.old_name,
    name_after: operation.new_name,
    can_restore: success,
    restored_at: null,
    restore_status: success ? "not_restored" : "unavailable",
    restore_error: error
  };
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.stat(targetPath);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error && "code" in error ? String(error.code) : "";
    if (code === "ENOENT") return false;
    throw error;
  }
}

async function resolveAvailableTargetPath(targetPath: string, reservedTargets: Set<string>): Promise<string | null> {
  const resolved = path.resolve(targetPath);
  if (!reservedTargets.has(normalizeResolvedPath(resolved)) && !(await pathExists(resolved))) return resolved;

  const directory = path.dirname(resolved);
  const extension = path.extname(resolved);
  const stem = path.basename(resolved, extension);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(directory, `${stem} (${index})${extension}`);
    if (!reservedTargets.has(normalizeResolvedPath(candidate)) && !(await pathExists(candidate))) return candidate;
  }
  return null;
}

function normalizeResolvedPath(targetPath: string): string {
  return path.resolve(targetPath).toLowerCase();
}

function withActualTarget(operation: OperationPreview, targetPath: string): OperationPreview {
  return {
    ...operation,
    target_path: targetPath,
    new_name: path.basename(targetPath)
  };
}
