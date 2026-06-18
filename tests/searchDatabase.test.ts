import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/core/database";
import type { FileRecord, OperationLog, ScanRoot } from "../src/types/domain";

let tempDir = "";
let database: Database | null = null;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zc-db-"));
  database = await Database.open(tempDir);
});

afterEach(async () => {
  database?.close();
  database = null;
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("SQLite FTS search database", () => {
  it("indexes filenames, paths, extension filters, and source switches", () => {
    const rootA = path.join(tempDir, "Downloads");
    const rootB = path.join(tempDir, "Projects");
    const db = expectDatabase();
    db.upsertScanRoots([makeRoot(rootA), makeRoot(rootB)]);
    db.upsertFiles([
      makeFile(path.join(rootA, "resume_2026.pdf"), "Career"),
      makeFile(path.join(rootA, "invoice_apple.pdf"), "Finance"),
      makeFile(path.join(rootB, "project_notes.md"), "Project")
    ]);

    expect(db.searchFiles({ query: "resume ext:pdf" })[0].file.name).toBe("resume_2026.pdf");
    expect(db.searchFiles({ query: "project notes" })[0].file.name).toBe("project_notes.md");

    const sources = db.getSearchSources();
    const downloadSource = sources.find((source) => source.path === rootA);
    expect(downloadSource).toBeTruthy();
    const filtered = db.searchFiles({ query: "project", sourceIds: [downloadSource!.id] });
    expect(filtered).toHaveLength(0);
  });

  it("tracks opened files and stale source state", () => {
    const root = path.join(tempDir, "Downloads");
    const filePath = path.join(root, "resume_2026.pdf");
    const db = expectDatabase();
    db.upsertScanRoots([makeRoot(root)]);
    db.upsertFiles([makeFile(filePath, "Career")]);

    const result = db.searchFiles({ query: "resume" })[0];
    db.recordFileOpened(result.file.id);
    db.markSearchSourceStaleByPath(filePath);

    const updated = db.getFileById(result.file.id);
    expect(updated?.open_count).toBe(1);
    expect(db.getSearchIndexState().stale_sources).toBe(1);
    expect(db.rebuildSearchIndex().stale_sources).toBe(0);
  });

  it("keeps scan root disk metrics in snapshots", () => {
    const root = path.join(tempDir, "Downloads");
    const db = expectDatabase();
    db.upsertScanRoots([{
      ...makeRoot(root),
      disk_total_size: 1000,
      disk_free_size: 750,
      scanned_size: 100,
      indexed_file_count: 1,
      skipped_count: 2,
      summarized_count: 1
    }]);
    db.upsertFiles([makeFile(path.join(root, "resume_2026.pdf"), "Career")]);

    const snapshot = db.getSnapshot();
    expect(snapshot.scanRoots[0].disk_total_size).toBe(1000);
    expect(snapshot.scanRoots[0].skipped_count).toBe(2);
    expect(snapshot.stats.diskUsageRatio).toBeGreaterThan(0);
  });

  it("pages file queries and filters them by active scan roots", () => {
    const rootA = path.join(tempDir, "Downloads");
    const rootB = path.join(tempDir, "Pictures");
    const db = expectDatabase();
    db.upsertScanRoots([makeRoot(rootA), makeRoot(rootB)]);
    db.upsertFiles([
      makeFile(path.join(rootA, "resume_2026.pdf"), "Career"),
      makeFile(path.join(rootA, "invoice_apple.pdf"), "Finance"),
      makeFile(path.join(rootB, "family.jpg"), "Media")
    ]);

    const firstPage = db.queryFilesPage({ limit: 2, offset: 0, sortBy: "name", sortDirection: "asc" });
    const secondPage = db.queryFilesPage({ limit: 2, offset: 2, sortBy: "name", sortDirection: "asc" });
    const scoped = db.queryFilesPage({ roots: [rootA], limit: 50, offset: 0 });

    expect(firstPage.total).toBe(3);
    expect(firstPage.files).toHaveLength(2);
    expect(secondPage.files).toHaveLength(1);
    expect(scoped.total).toBe(2);
    expect(scoped.files.every((file) => file.path.startsWith(rootA))).toBe(true);
  });

  it("prunes operation logs after the retention window", () => {
    const db = expectDatabase();
    const oldDate = new Date(Date.now() - 61 * 86_400_000).toISOString();
    const recentDate = new Date(Date.now() - 10 * 86_400_000).toISOString();

    db.addOperationLogs([
      makeLog("old-restorable", oldDate, "not_restored"),
      makeLog("old-restored", oldDate, "restored"),
      makeLog("recent", recentDate, "not_restored")
    ]);

    db.pruneOperationLogs(60);

    const remaining = db.getOperationLogs().map((log) => log.id);
    expect(remaining).toEqual(["recent"]);
  });

  it("uses 30 days as the default restore retention setting", () => {
    const db = expectDatabase();
    const oldDate = new Date(Date.now() - 31 * 86_400_000).toISOString();
    const recentDate = new Date(Date.now() - 29 * 86_400_000).toISOString();

    db.addOperationLogs([
      makeLog("old-default", oldDate, "not_restored"),
      makeLog("recent-default", recentDate, "not_restored")
    ]);

    db.pruneOperationLogs();

    expect(db.getRestoreRetentionDays()).toBe(30);
    expect(db.getOperationLogs().map((log) => log.id)).toEqual(["recent-default"]);

    db.setSetting("restoreRetentionDays", "90");
    expect(db.getRestoreRetentionDays()).toBe(90);
  });
});

function expectDatabase(): Database {
  if (!database) throw new Error("Database was not initialized");
  return database;
}

function makeRoot(rootPath: string): ScanRoot {
  const now = new Date().toISOString();
  return {
    id: rootPath,
    path: rootPath,
    platform: process.platform,
    enabled: true,
    last_scanned_at: now,
    created_at: now
  };
}

function makeFile(filePath: string, purpose: FileRecord["purpose"]): FileRecord {
  const now = new Date().toISOString();
  return {
    id: filePath,
    name: path.basename(filePath),
    path: filePath,
    directory: path.dirname(filePath),
    extension: path.extname(filePath).replace(".", ""),
    size: 100,
    file_type: "Document",
    purpose,
    lifecycle: "Reference",
    context: purpose,
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
    suggested_name: path.basename(filePath),
    confidence: 0.8,
    classification_reason: "test",
    matched_rules: ["test"],
    requires_confirmation: false
  };
}

function makeLog(id: string, createdAt: string, restoreStatus: OperationLog["restore_status"]): OperationLog {
  const source = path.join(tempDir, `${id}-source.pdf`);
  const target = path.join(tempDir, `${id}-target.pdf`);
  return {
    id,
    batch_id: "batch-retention",
    operation_type: "move",
    source_path: source,
    target_path: target,
    old_name: path.basename(source),
    new_name: path.basename(target),
    status: "success",
    error_message: null,
    created_at: createdAt,
    can_undo: true,
    path_before: source,
    path_after: target,
    name_before: path.basename(source),
    name_after: path.basename(target),
    can_restore: true,
    restored_at: restoreStatus === "restored" ? createdAt : null,
    restore_status: restoreStatus,
    restore_error: null
  };
}
