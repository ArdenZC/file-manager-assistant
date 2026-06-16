import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/core/database";
import type { FileRecord, ScanRoot } from "../src/types/domain";

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
