import fs from "node:fs/promises";
import path from "node:path";
import type { ExecuteOperationResult, FileRecord, OperationLog, OperationPreview } from "../types/domain.js";
import { safeMoveFile } from "./fileMoves.js";
import { nowIso, randomId } from "./id.js";
import { validateOperationPreview } from "./operationGuards.js";

export async function executeOperations(
  files: FileRecord[],
  operations: OperationPreview[]
): Promise<ExecuteOperationResult> {
  const logs: OperationLog[] = [];
  const batchId = randomId("batch");
  const byId = new Map(files.map((file) => [file.id, file]));
  const updatedFiles: FileRecord[] = [];

  for (const operation of operations) {
    const createdAt = nowIso();
    const file = byId.get(operation.fileId);

    if (!file) {
      logs.push(makeLog(operation, batchId, "failed", "File record no longer exists", createdAt));
      continue;
    }

    const validationError = validateOperationPreview(file, operation);
    if (validationError) {
      logs.push(makeLog(operation, batchId, "skipped", validationError, createdAt));
      continue;
    }

    try {
      const targetPath = await resolveAvailableTargetPath(operation.target_path);
      if (!targetPath) {
        logs.push(makeLog(operation, batchId, "failed", "No available non-conflicting target path", createdAt));
        continue;
      }
      const actualOperation = withActualTarget(operation, targetPath);
      await safeMoveFile(operation.source_path, targetPath);
      const nextFile = {
        ...file,
        path: targetPath,
        directory: path.dirname(targetPath),
        name: path.basename(targetPath),
        suggested_action: "Keep" as const,
        suggested_target_path: "",
        suggested_name: path.basename(targetPath),
        requires_confirmation: false,
        last_seen_at: createdAt
      };
      updatedFiles.push(nextFile);
      logs.push(makeLog(actualOperation, batchId, "success", null, createdAt));
    } catch (error) {
      logs.push(makeLog(operation, batchId, "failed", readableError(error), createdAt));
    }
  }

  return { logs, updatedFiles, batch_id: batchId };
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

async function resolveAvailableTargetPath(targetPath: string): Promise<string | null> {
  const resolved = path.resolve(targetPath);
  if (!(await pathExists(resolved))) return resolved;

  const directory = path.dirname(resolved);
  const extension = path.extname(resolved);
  const stem = path.basename(resolved, extension);
  for (let index = 1; index <= 999; index += 1) {
    const candidate = path.join(directory, `${stem} (${index})${extension}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  return null;
}

function withActualTarget(operation: OperationPreview, targetPath: string): OperationPreview {
  return {
    ...operation,
    target_path: targetPath,
    new_name: path.basename(targetPath)
  };
}
