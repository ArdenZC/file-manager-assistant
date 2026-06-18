import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRestorePreview, restoreBatch } from "../src/core/restoreExecutor";
import type { OperationLog } from "../src/types/domain";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zc-restore-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("restore executor", () => {
  it("previews and restores successful Zen Canvas operations", async () => {
    const before = path.join(tempDir, "source.txt");
    const after = path.join(tempDir, "renamed.txt");
    await fs.writeFile(after, "ok");

    const preview = await createRestorePreview([makeLog(before, after)]);
    expect(preview.items[0].can_restore).toBe(true);

    const result = await restoreBatch([makeLog(before, after)]);
    expect(result.restored).toBe(1);
    await expect(fs.readFile(before, "utf8")).resolves.toBe("ok");
    await expect(fs.stat(after)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("blocks restore when the original path already exists", async () => {
    const before = path.join(tempDir, "source.txt");
    const after = path.join(tempDir, "renamed.txt");
    await fs.writeFile(before, "existing");
    await fs.writeFile(after, "ok");

    const preview = await createRestorePreview([makeLog(before, after)]);
    expect(preview.items[0].can_restore).toBe(false);
    expect(preview.items[0].blocking_reason).toContain("already exists");
  });

  it("restores with copy and unlink when rename reports a cross-device move", async () => {
    const before = path.join(tempDir, "source.txt");
    const after = path.join(tempDir, "renamed.txt");
    await fs.writeFile(after, "restore-cross-device");
    const exdev = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(exdev);

    const result = await restoreBatch([makeLog(before, after)]);

    expect(result.restored).toBe(1);
    await expect(fs.readFile(before, "utf8")).resolves.toBe("restore-cross-device");
    await expect(fs.stat(after)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function makeLog(before: string, after: string): OperationLog {
  const now = new Date().toISOString();
  return {
    id: `log_${path.basename(after)}`,
    batch_id: "batch_test",
    operation_type: "rename",
    source_path: before,
    target_path: after,
    old_name: path.basename(before),
    new_name: path.basename(after),
    status: "success",
    error_message: null,
    created_at: now,
    can_undo: true,
    path_before: before,
    path_after: after,
    name_before: path.basename(before),
    name_after: path.basename(after),
    can_restore: true,
    restored_at: null,
    restore_status: "not_restored",
    restore_error: null
  };
}
