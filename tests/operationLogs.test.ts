import { describe, expect, it } from "vitest";
import type { OperationLog } from "../src/types/domain";
import { MAX_LOGS, mergeOperationLogs } from "../src/hooks/useOperationQueue";

describe("mergeOperationLogs", () => {
  it("keeps current session logs before persisted logs", () => {
    const persisted = [operationLog("persisted")];
    const current = [operationLog("current")];

    const merged = mergeOperationLogs(persisted, current);

    expect(merged.map((log) => log.id)).toEqual(["current", "persisted"]);
  });

  it("deduplicates logs by id with current session logs winning", () => {
    const persisted = [operationLog("same-id", "persisted/path.txt")];
    const current = [operationLog("same-id", "current/path.txt")];

    const merged = mergeOperationLogs(persisted, current);

    expect(merged).toHaveLength(1);
    expect(merged[0].path_after).toBe("current/path.txt");
  });

  it("does not exceed the maximum retained logs", () => {
    const persisted = Array.from({ length: MAX_LOGS + 5 }, (_, index) =>
      operationLog(`persisted-${index}`)
    );

    const merged = mergeOperationLogs(persisted, []);

    expect(merged).toHaveLength(MAX_LOGS);
  });
});

function operationLog(id: string, pathAfter = `${id}.txt`): OperationLog {
  return {
    id,
    batch_id: "batch",
    operation_type: "move",
    source_path: "source.txt",
    target_path: pathAfter,
    old_name: "source.txt",
    new_name: pathAfter,
    status: "success",
    error_message: null,
    created_at: "1900000000000",
    can_undo: true,
    path_before: "source.txt",
    path_after: pathAfter,
    name_before: "source.txt",
    name_after: pathAfter,
    can_restore: true,
    restored_at: null,
    restore_status: "not_restored",
    restore_error: null
  };
}
