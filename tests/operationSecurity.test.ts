import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeOperations } from "../src/core/operationExecutor";
import { isSafeFileName, validateOperationPreview } from "../src/core/operationGuards";
import type { FileRecord, OperationPreview } from "../src/types/domain";

let tempDir = "";

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fma-security-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("operation execution safety", () => {
  it("executes a confirmed safe rename and records success", async () => {
    const source = path.join(tempDir, "source.txt");
    const target = path.join(tempDir, "renamed.txt");
    await fs.writeFile(source, "ok");

    const file = makeFile(source, { suggested_action: "Rename", suggested_name: "renamed.txt" });
    const operation = makeOperation(file, target, "renamed.txt", "rename");

    const result = await executeOperations([file], [operation]);

    await expect(fs.readFile(target, "utf8")).resolves.toBe("ok");
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.logs[0].status).toBe("success");
    expect(result.updatedFiles[0].path).toBe(target);
  });

  it("rejects sensitive files even when an operation is supplied", () => {
    const source = path.join(tempDir, "passport.pdf");
    const file = makeFile(source, {
      risk_level: "Sensitive",
      suggested_action: "Move",
      suggested_target_path: tempDir
    });
    const operation = makeOperation(file, path.join(tempDir, "passport-reviewed.pdf"), "passport-reviewed.pdf", "move");

    expect(validateOperationPreview(file, operation)).toContain("Sensitive files");
  });

  it("rejects forged source paths", () => {
    const source = path.join(tempDir, "source.txt");
    const forged = path.join(tempDir, "forged.txt");
    const file = makeFile(source, { suggested_action: "Rename", suggested_name: "renamed.txt" });
    const operation = makeOperation(file, path.join(tempDir, "renamed.txt"), "renamed.txt", "rename", forged);

    expect(validateOperationPreview(file, operation)).toContain("Source path no longer matches");
  });

  it("rejects relative target paths and unsafe names", () => {
    const source = path.join(tempDir, "source.txt");
    const file = makeFile(source, { suggested_action: "Rename", suggested_name: "renamed.txt" });
    const relativeOperation = makeOperation(file, "relative-target.txt", "relative-target.txt", "rename");
    const unsafeOperation = makeOperation(file, path.join(tempDir, "nested.txt"), "folder/nested.txt", "rename");

    expect(validateOperationPreview(file, relativeOperation)).toContain("absolute");
    expect(validateOperationPreview(file, unsafeOperation)).toContain("safe");
    expect(isSafeFileName("folder/nested.txt")).toBe(false);
    expect(isSafeFileName("bad:name.txt")).toBe(false);
  });

  it("rejects unsupported runtime operation types", () => {
    const source = path.join(tempDir, "source.txt");
    const file = makeFile(source, { suggested_action: "Move", suggested_target_path: tempDir });
    const operation = makeOperation(
      file,
      path.join(tempDir, "delete-me.txt"),
      "delete-me.txt",
      "delete" as OperationPreview["operation_type"]
    );

    expect(validateOperationPreview(file, operation)).toContain("Unsupported operation type");
  });

  it("adds a non-destructive suffix when the target file already exists", async () => {
    const source = path.join(tempDir, "source.txt");
    const target = path.join(tempDir, "renamed.txt");
    const suffixedTarget = path.join(tempDir, "renamed (1).txt");
    await fs.writeFile(source, "source");
    await fs.writeFile(target, "existing");

    const file = makeFile(source, { suggested_action: "Rename", suggested_name: "renamed.txt" });
    const operation = makeOperation(file, target, "renamed.txt", "rename");

    const result = await executeOperations([file], [operation]);

    expect(result.logs[0].status).toBe("success");
    expect(result.logs[0].target_path).toBe(suffixedTarget);
    expect(result.logs[0].new_name).toBe("renamed (1).txt");
    expect(result.updatedFiles[0].path).toBe(suffixedTarget);
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("existing");
    await expect(fs.readFile(suffixedTarget, "utf8")).resolves.toBe("source");
  });

  it("falls back to copy and unlink when rename reports a cross-device move", async () => {
    const source = path.join(tempDir, "source.txt");
    const target = path.join(tempDir, "moved.txt");
    await fs.writeFile(source, "cross-device");
    const exdev = Object.assign(new Error("cross-device link not permitted"), { code: "EXDEV" });
    vi.spyOn(fs, "rename").mockRejectedValueOnce(exdev);

    const file = makeFile(source, { suggested_action: "Move", suggested_target_path: tempDir, suggested_name: "moved.txt" });
    const operation = makeOperation(file, target, "moved.txt", "move");

    const result = await executeOperations([file], [operation]);

    expect(result.logs[0].status).toBe("success");
    expect(result.updatedFiles[0].path).toBe(target);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("cross-device");
    await expect(fs.stat(source)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects protected system target folders", () => {
    const source = path.join(tempDir, "source.txt");
    const root = path.parse(path.resolve(tempDir)).root;
    const target = path.join(root, "Windows", "blocked.txt");
    const file = makeFile(source, { suggested_action: "Move", suggested_target_path: path.dirname(target) });
    const operation = makeOperation(file, target, "blocked.txt", "move");

    expect(validateOperationPreview(file, operation)).toContain("protected system location");
  });
});

function makeFile(sourcePath: string, overrides: Partial<FileRecord> = {}): FileRecord {
  const now = new Date().toISOString();
  return {
    id: sourcePath,
    name: path.basename(sourcePath),
    path: sourcePath,
    directory: path.dirname(sourcePath),
    extension: path.extname(sourcePath).replace(".", ""),
    size: 12,
    file_type: "Document",
    purpose: "Unknown",
    lifecycle: "Reference",
    context: "",
    risk_level: "Normal",
    hash: null,
    created_at: now,
    modified_at: now,
    scanned_at: now,
    last_seen_at: now,
    is_hidden: false,
    is_deleted: false,
    is_duplicate: false,
    suggested_action: "Keep",
    suggested_target_path: "",
    suggested_name: path.basename(sourcePath),
    confidence: 0.8,
    classification_reason: "test",
    matched_rules: ["test"],
    requires_confirmation: false,
    ...overrides
  };
}

function makeOperation(
  file: FileRecord,
  targetPath: string,
  newName: string,
  type: OperationPreview["operation_type"],
  sourcePath = file.path
): OperationPreview {
  return {
    id: `op_${file.id}`,
    fileId: file.id,
    operation_type: type,
    source_path: sourcePath,
    target_path: targetPath,
    old_name: file.name,
    new_name: newName,
    status: "pending",
    risk_level: file.risk_level,
    confidence: file.confidence,
    requires_confirmation: true,
    reason: file.classification_reason
  };
}
