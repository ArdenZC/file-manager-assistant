import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileRecord, ScanResult, ScanRoot } from "../types/domain.js";
import { getExtension, getFileType } from "./fileTypes.js";
import { nowIso, stableId } from "./id.js";

const ignoredDirectoryNames = new Set([
  "node_modules",
  ".git",
  "appdata",
  "library",
  "system32",
  "$recycle.bin",
  "windows"
]);

const maxFilesPerScan = 5000;
const maxDepth = 6;
const maxHashBytes = 512 * 1024 * 1024;

export async function scanDefaultRoots(): Promise<ScanResult> {
  const home = os.homedir();
  const rootNames = process.platform === "darwin"
    ? ["Desktop", "Downloads", "Documents"]
    : ["Desktop", "Downloads", "Documents"];
  const rootPaths = rootNames.map((name) => path.join(home, name));
  return scanRoots(rootPaths);
}

export async function scanRoots(rootPaths: string[]): Promise<ScanResult> {
  const scannedAt = nowIso();
  const files: FileRecord[] = [];
  const skipped: ScanResult["skipped"] = [];
  const roots: ScanRoot[] = [];

  for (const rootPath of rootPaths) {
    const root: ScanRoot = {
      id: stableId(rootPath),
      path: rootPath,
      platform: process.platform,
      enabled: true,
      last_scanned_at: scannedAt,
      created_at: scannedAt
    };
    roots.push(root);

    try {
      const stat = await fs.stat(rootPath);
      if (!stat.isDirectory()) {
        skipped.push({ path: rootPath, reason: "Not a directory" });
        continue;
      }
      await scanDirectory(rootPath, files, skipped, scannedAt, 0);
    } catch (error) {
      skipped.push({ path: rootPath, reason: readableError(error) });
    }
  }

  await fillDuplicateHashes(files);
  return { roots, files, skipped, scannedAt };
}

async function scanDirectory(
  directory: string,
  files: FileRecord[],
  skipped: ScanResult["skipped"],
  scannedAt: string,
  depth: number
) {
  if (files.length >= maxFilesPerScan || depth > maxDepth || shouldSkipDirectory(directory)) return;

  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" }) as Dirent<string>[];
  } catch (error) {
    skipped.push({ path: directory, reason: readableError(error) });
    return;
  }

  for (const entry of entries) {
    if (files.length >= maxFilesPerScan) return;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith(".")) {
        await scanDirectory(fullPath, files, skipped, scannedAt, depth + 1);
      }
      continue;
    }
    if (!entry.isFile()) continue;

    try {
      const stat = await fs.stat(fullPath);
      const extension = getExtension(fullPath);
      files.push({
        id: stableId(fullPath),
        name: entry.name,
        path: fullPath,
        directory,
        extension,
        size: stat.size,
        file_type: getFileType(fullPath),
        purpose: "Unknown",
        lifecycle: "Reference",
        context: "",
        risk_level: "Unknown",
        hash: null,
        created_at: stat.birthtime.toISOString(),
        modified_at: stat.mtime.toISOString(),
        scanned_at: scannedAt,
        last_seen_at: scannedAt,
        is_hidden: entry.name.startsWith("."),
        is_deleted: false,
        is_duplicate: false,
        suggested_action: "Keep",
        suggested_target_path: "",
        suggested_name: entry.name,
        confidence: 0,
        classification_reason: "",
        matched_rules: [],
        requires_confirmation: false
      });
    } catch (error) {
      skipped.push({ path: fullPath, reason: readableError(error) });
    }
  }
}

async function fillDuplicateHashes(files: FileRecord[]) {
  const bySize = new Map<number, FileRecord[]>();
  for (const file of files) {
    if (file.size <= 0 || file.size > maxHashBytes) continue;
    const bucket = bySize.get(file.size) ?? [];
    bucket.push(file);
    bySize.set(file.size, bucket);
  }

  for (const bucket of bySize.values()) {
    if (bucket.length < 2) continue;
    await Promise.all(
      bucket.map(async (file) => {
        file.hash = await hashFile(file.path);
      })
    );
  }
}

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function shouldSkipDirectory(directory: string): boolean {
  const parts = directory.toLowerCase().split(/[\\/]+/);
  return parts.some((part) => ignoredDirectoryNames.has(part));
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
