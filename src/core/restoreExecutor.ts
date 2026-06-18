import fs from "node:fs/promises";
import type { OperationLog, RestoreBatchResult, RestorePreview, RestorePreviewItem } from "../types/domain.js";
import { mapWithConcurrency } from "./concurrency.js";
import { safeMoveFile } from "./fileMoves.js";

export async function createRestorePreview(logs: OperationLog[]): Promise<RestorePreview> {
  const batchId = logs[0]?.batch_id ?? "";
  const items = await mapWithConcurrency(logs, 16, toPreviewItem);
  return { batch_id: batchId, items };
}

export async function restoreBatch(logs: OperationLog[]): Promise<RestoreBatchResult> {
  const preview = await createRestorePreview(logs);
  const items: RestorePreviewItem[] = [];
  let restored = 0;
  let failed = 0;
  let skipped = 0;

  for (const item of preview.items) {
    if (!item.can_restore) {
      skipped += 1;
      items.push(item);
      continue;
    }

    try {
      await safeMoveFile(item.current_path, item.restore_path);
      restored += 1;
      items.push({ ...item, can_restore: false, blocking_reason: "Restored" });
    } catch (error) {
      failed += 1;
      items.push({ ...item, can_restore: false, blocking_reason: readableError(error) });
    }
  }

  return { batch_id: preview.batch_id, restored, failed, skipped, items };
}

async function toPreviewItem(log: OperationLog): Promise<RestorePreviewItem> {
  let blockingReason: string | null = null;
  if (log.status !== "success" || !log.can_restore) {
    blockingReason = "Only successful Zen Canvas operations can be restored";
  } else if (log.restore_status === "restored") {
    blockingReason = "Already restored";
  } else if (log.restore_status !== "not_restored") {
    blockingReason = log.restore_error || "This item is unavailable for restore";
  } else if (!(await pathExists(log.path_after))) {
    blockingReason = "Current file path no longer exists";
  } else if (await pathExists(log.path_before)) {
    blockingReason = "Restore target already exists";
  }

  return {
    log_id: log.id,
    batch_id: log.batch_id,
    operation_type: log.operation_type,
    current_path: log.path_after,
    restore_path: log.path_before,
    old_name: log.name_before,
    new_name: log.name_after,
    can_restore: blockingReason === null,
    blocking_reason: blockingReason
  };
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

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
