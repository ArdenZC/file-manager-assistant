import fs from "node:fs/promises";
import path from "node:path";
import type { ExecuteOperationResult, FileRecord, OperationLog, OperationPreview } from "../types/domain.js";
import { nowIso, randomId } from "./id.js";

export async function executeOperations(
  files: FileRecord[],
  operations: OperationPreview[]
): Promise<ExecuteOperationResult> {
  const logs: OperationLog[] = [];
  const byId = new Map(files.map((file) => [file.id, file]));
  const updatedFiles: FileRecord[] = [];

  for (const operation of operations) {
    const createdAt = nowIso();
    const file = byId.get(operation.fileId);

    if (!file) {
      logs.push(makeLog(operation, "failed", "File record no longer exists", createdAt));
      continue;
    }

    if (operation.risk_level === "Sensitive") {
      logs.push(makeLog(operation, "skipped", "Sensitive files are not executed in MVP", createdAt));
      continue;
    }

    try {
      await fs.mkdir(path.dirname(operation.target_path), { recursive: true });
      await fs.rename(operation.source_path, operation.target_path);
      const nextFile = {
        ...file,
        path: operation.target_path,
        directory: path.dirname(operation.target_path),
        name: path.basename(operation.target_path),
        suggested_action: "Keep" as const,
        suggested_target_path: "",
        suggested_name: path.basename(operation.target_path),
        requires_confirmation: false,
        last_seen_at: createdAt
      };
      updatedFiles.push(nextFile);
      logs.push(makeLog(operation, "success", null, createdAt));
    } catch (error) {
      logs.push(makeLog(operation, "failed", readableError(error), createdAt));
    }
  }

  return { logs, updatedFiles };
}

function makeLog(
  operation: OperationPreview,
  status: OperationLog["status"],
  error: string | null,
  createdAt: string
): OperationLog {
  return {
    id: randomId("log"),
    operation_type: operation.operation_type,
    source_path: operation.source_path,
    target_path: operation.target_path,
    old_name: operation.old_name,
    new_name: operation.new_name,
    status,
    error_message: error,
    created_at: createdAt,
    can_undo: status === "success"
  };
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

