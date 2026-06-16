import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Database } from "../src/core/database";
import type { FileRecord, ScanRoot } from "../src/types/domain";

let tempDir = "";
let database: Database | null = null;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "zc-perf-"));
  database = await Database.open(tempDir);
});

afterEach(async () => {
  database?.close();
  database = null;
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe.skipIf(process.env.RUN_PERF_100K !== "1")("100k local search performance", () => {
  it("returns first-page FTS results under the MVP latency target", { timeout: 120_000 }, () => {
    const root = path.join(tempDir, "Downloads");
    const db = expectDatabase();
    db.upsertScanRoots([makeRoot(root)]);

    const files: FileRecord[] = Array.from({ length: 100_000 }, (_, index) => {
      const prefix = index % 1000 === 0 ? "resume" : index % 997 === 0 ? "invoice" : "document";
      return makeFile(path.join(root, `${prefix}_${String(index).padStart(6, "0")}.pdf`), index);
    });
    db.upsertFiles(files);

    const start = performance.now();
    const results = db.searchFiles({ query: "resume ext:pdf", limit: 20 });
    const duration = performance.now() - start;

    expect(results.length).toBeGreaterThan(0);
    expect(duration).toBeLessThan(100);
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

function makeFile(filePath: string, index: number): FileRecord {
  const now = new Date(Date.now() - index * 1000).toISOString();
  return {
    id: filePath,
    name: path.basename(filePath),
    path: filePath,
    directory: path.dirname(filePath),
    extension: "pdf",
    size: 100 + index,
    file_type: "Document",
    purpose: index % 997 === 0 ? "Finance" : "Career",
    lifecycle: "Reference",
    context: index % 997 === 0 ? "Finance" : "Career",
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
    classification_reason: "performance fixture",
    matched_rules: ["performance fixture"],
    requires_confirmation: false
  };
}
