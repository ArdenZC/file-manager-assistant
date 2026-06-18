import crypto from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream, type Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileRecord, ScanProgress, ScanResult, ScanRoot } from "../types/domain.js";
import { mapWithConcurrency } from "./concurrency.js";
import { getExtension, getFileType } from "./fileTypes.js";
import { nowIso, stableId } from "./id.js";

const ignoredDirectoryNames = new Set([
  "node_modules",
  "vendor",
  "vendors",
  "packages",
  ".git",
  ".hg",
  ".svn",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".yarn",
  ".pnpm-store",
  ".gradle",
  ".idea",
  ".vscode",
  ".vs",
  ".venv",
  ".virtualenv",
  "__pycache__",
  "__macosx",
  "appdata",
  "application data",
  "application support",
  "build",
  "bin",
  "coverage",
  "debug",
  "dist",
  "env",
  "logs",
  "obj",
  "library",
  "out",
  "program files",
  "program files (x86)",
  "programdata",
  "release",
  "system32",
  "target",
  "temp",
  "tmp",
  "venv",
  "windowsapps",
  "$recycle.bin",
  "system volume information",
  "windows"
]);

const projectMarkerFiles = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lockb",
  "tsconfig.json",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.ts",
  "next.config.js",
  "next.config.mjs",
  "pyproject.toml",
  "requirements.txt",
  "poetry.lock",
  "pipfile",
  "cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "settings.gradle",
  "gradlew",
  "pubspec.yaml",
  "composer.json",
  "gemfile",
  "makefile",
  "cmakelists.txt",
  "docker-compose.yml"
]);

const projectMarkerExtensions = [
  ".aep",
  ".blend",
  ".csproj",
  ".fsproj",
  ".logicx",
  ".prproj",
  ".sln",
  ".uproject",
  ".vbproj",
  ".xcodeproj",
  ".xcworkspace"
];

const projectMarkerDirectoryGroups = [
  ["assets", "projectsettings"],
  ["content", "config"],
  ["source", "config"],
  ["footage", "renders"],
  ["media", "exports"],
  ["raw", "exports"]
];

const packageDirectoryExtensions = [
  ".app",
  ".band",
  ".fcpxbundle",
  ".imovielibrary",
  ".logicx",
  ".photoslibrary",
  ".xcodeproj",
  ".xcworkspace"
];

const ignoredFileNames = new Set([
  ".ds_store",
  "desktop.ini",
  "thumbs.db",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb"
]);

const ignoredFileExtensions = new Set([
  ".bak",
  ".cache",
  ".class",
  ".dll",
  ".dmp",
  ".dylib",
  ".ilk",
  ".ini",
  ".lib",
  ".lock",
  ".log",
  ".map",
  ".o",
  ".obj",
  ".pdb",
  ".pyc",
  ".so",
  ".swp",
  ".sys",
  ".tmp"
]);

const maxFilesPerScan = 5000;
const maxDepth = 6;
const maxHashBytes = 64 * 1024 * 1024;

interface ScanCounters {
  skipped: number;
  summarized: number;
  scannedFiles: number;
  indexedFiles: number;
  lastProgressAt: number;
}

type ScannerProgress = Omit<ScanProgress, "scanId">;

export interface ScanOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ScannerProgress) => void;
}

export class ScanCanceledError extends Error {
  constructor() {
    super("Scan canceled");
    this.name = "ScanCanceledError";
  }
}

export async function scanDefaultRoots(options: ScanOptions = {}): Promise<ScanResult> {
  const home = os.homedir();
  const rootNames = process.platform === "darwin"
    ? ["Desktop", "Downloads", "Documents", "Pictures", "Movies", "Music"]
    : ["Desktop", "Downloads", "Documents", "Pictures", "Videos", "Music"];
  const rootPaths = rootNames.map((name) => path.join(home, name));
  return scanRoots(rootPaths, options);
}

export async function scanRoots(rootPaths: string[], options: ScanOptions = {}): Promise<ScanResult> {
  const scannedAt = nowIso();
  const files: FileRecord[] = [];
  const skipped: ScanResult["skipped"] = [];
  const roots: ScanRoot[] = [];
  const counters: ScanCounters = { skipped: 0, summarized: 0, scannedFiles: 0, indexedFiles: 0, lastProgressAt: 0 };
  const rootsTotal = rootPaths.length;

  emitProgress(options, counters, "queued", null, rootsTotal, 0, "Preparing scan");

  for (const [rootIndex, rootPath] of rootPaths.entries()) {
    throwIfAborted(options.signal);
    const root: ScanRoot = {
      id: stableId(rootPath),
      path: rootPath,
      platform: process.platform,
      enabled: true,
      last_scanned_at: scannedAt,
      created_at: scannedAt,
      disk_total_size: null,
      disk_free_size: null,
      scanned_size: 0,
      indexed_file_count: 0,
      skipped_count: 0,
      summarized_count: 0
    };
    roots.push(root);
    emitProgress(options, counters, "scanning", rootPath, rootsTotal, rootIndex, "Scanning folder");

    try {
      const stat = await fs.stat(rootPath);
      if (!stat.isDirectory()) {
        recordSkipped(skipped, counters, rootPath, "Not a directory");
        root.skipped_count = 1;
        emitProgress(options, counters, "indexing", rootPath, rootsTotal, rootIndex + 1, "Root skipped");
        continue;
      }
      const diskInfo = await getDiskInfo(rootPath);
      root.disk_total_size = diskInfo.total;
      root.disk_free_size = diskInfo.free;
      const beforeCount = files.length;
      const beforeSkipped = counters.skipped;
      const beforeSummarized = counters.summarized;
      await scanDirectory(rootPath, files, skipped, scannedAt, 0, counters, options, rootsTotal, rootIndex);
      const rootFiles = files.slice(beforeCount);
      root.scanned_size = rootFiles.reduce((sum, file) => sum + file.size, 0);
      root.indexed_file_count = rootFiles.length;
      root.skipped_count = counters.skipped - beforeSkipped;
      root.summarized_count = counters.summarized - beforeSummarized;
      counters.indexedFiles = files.length;
      emitProgress(options, counters, "indexing", rootPath, rootsTotal, rootIndex + 1, "Indexing scan result");
    } catch (error) {
      if (error instanceof ScanCanceledError) throw error;
      recordSkipped(skipped, counters, rootPath, readableError(error));
      root.skipped_count = (root.skipped_count ?? 0) + 1;
    }
  }

  await fillDuplicateHashes(files, options.signal);
  counters.indexedFiles = files.length;
  emitProgress(options, counters, "done", null, rootsTotal, rootsTotal, "Scan completed");
  return { roots, files, skipped, scannedAt };
}

async function scanDirectory(
  directory: string,
  files: FileRecord[],
  skipped: ScanResult["skipped"],
  scannedAt: string,
  depth: number,
  counters: ScanCounters,
  options: ScanOptions,
  rootsTotal: number,
  rootsDone: number
) {
  throwIfAborted(options.signal);
  if (files.length >= maxFilesPerScan) return;
  if (depth > maxDepth) {
    recordSkipped(skipped, counters, directory, "Depth limit reached");
    return;
  }
  const directorySkipReason = getDirectorySkipReason(directory);
  if (directorySkipReason) {
    recordSkipped(skipped, counters, directory, directorySkipReason);
    return;
  }

  let entries: Dirent<string>[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true, encoding: "utf8" }) as Dirent<string>[];
  } catch (error) {
    recordSkipped(skipped, counters, directory, readableError(error));
    emitProgressThrottled(options, counters, "scanning", directory, rootsTotal, rootsDone);
    return;
  }

  if (isProjectRoot(entries) || isPackageDirectory(directory)) {
    try {
      await addProjectFolderRecord(directory, files, scannedAt);
      counters.summarized += 1;
      counters.scannedFiles = files.length;
      recordSkipped(skipped, counters, directory, "Complete project/package summarized; internal files skipped");
      emitProgress(options, counters, "scanning", directory, rootsTotal, rootsDone, "Project/package summarized");
    } catch (error) {
      recordSkipped(skipped, counters, directory, readableError(error));
    }
    return;
  }

  for (const entry of entries) {
    throwIfAborted(options.signal);
    if (files.length >= maxFilesPerScan) return;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) {
        recordSkipped(skipped, counters, fullPath, "Hidden directory skipped");
      } else {
        await scanDirectory(fullPath, files, skipped, scannedAt, depth + 1, counters, options, rootsTotal, rootsDone);
      }
      continue;
    }
    if (!entry.isFile()) continue;
    const fileSkipReason = getFileSkipReason(entry.name);
    if (fileSkipReason) {
      recordSkipped(skipped, counters, fullPath, fileSkipReason);
      continue;
    }

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
        requires_confirmation: false,
        indexed_at: scannedAt,
        source_id: stableId(findSourceRoot(directory)),
        is_stale: false
      });
      counters.scannedFiles = files.length;
      emitProgressThrottled(options, counters, "scanning", fullPath, rootsTotal, rootsDone);
    } catch (error) {
      recordSkipped(skipped, counters, fullPath, readableError(error));
      emitProgressThrottled(options, counters, "scanning", fullPath, rootsTotal, rootsDone);
    }
  }
}

async function addProjectFolderRecord(directory: string, files: FileRecord[], scannedAt: string) {
  if (files.some((file) => file.path === directory)) return;
  const stat = await fs.stat(directory);
  const name = path.basename(directory);
  const parent = path.dirname(directory);
  files.push({
    id: stableId(directory),
    name,
    path: directory,
    directory: parent,
    extension: "folder",
    size: 0,
    file_type: "Other",
    purpose: "Project",
    lifecycle: "Active",
    context: "Project Folder",
    risk_level: "Normal",
    hash: null,
    created_at: stat.birthtime.toISOString(),
    modified_at: stat.mtime.toISOString(),
    scanned_at: scannedAt,
    last_seen_at: scannedAt,
    is_hidden: name.startsWith("."),
    is_deleted: false,
    is_duplicate: false,
    suggested_action: "Review",
    suggested_target_path: "",
    suggested_name: name,
    confidence: 0.86,
    classification_reason: "Detected project root; internal files are summarized to avoid moving configured environments",
    matched_rules: ["Project folder boundary"],
    requires_confirmation: true,
    dispatch_zone: "CoreAssets",
    recommended_folder: "Projects",
    dispatch_reason: "Project environments should be organized at the folder boundary",
    next_action: "Review project folder placement only",
    indexed_at: scannedAt,
    source_id: stableId(findSourceRoot(directory)),
    is_stale: false
  });
}

function isProjectRoot(entries: Dirent<string>[]) {
  const names = new Set(entries.map((entry) => entry.name.toLowerCase()));
  if (projectMarkerDirectoryGroups.some((group) => group.every((name) => names.has(name)))) {
    return true;
  }
  return entries.some((entry) => {
    const name = entry.name.toLowerCase();
    if (entry.isFile() && projectMarkerFiles.has(name)) return true;
    if (entry.isFile() && projectMarkerExtensions.some((extension) => name.endsWith(extension))) return true;
    return entry.isDirectory() && [".git", ".hg", ".svn"].includes(name);
  });
}

function isPackageDirectory(directory: string): boolean {
  const lower = directory.toLowerCase();
  return packageDirectoryExtensions.some((extension) => lower.endsWith(extension));
}

async function fillDuplicateHashes(files: FileRecord[], signal?: AbortSignal) {
  const bySize = new Map<number, FileRecord[]>();
  for (const file of files) {
    throwIfAborted(signal);
    if (file.size <= 0 || file.size > maxHashBytes) continue;
    const bucket = bySize.get(file.size) ?? [];
    bucket.push(file);
    bySize.set(file.size, bucket);
  }

  for (const bucket of bySize.values()) {
    throwIfAborted(signal);
    if (bucket.length < 2) continue;
    await mapWithConcurrency(bucket, 8, async (file) => {
      throwIfAborted(signal);
      file.hash = await hashFile(file.path);
    });
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

function getDirectorySkipReason(directory: string): string | null {
  const parts = directory.toLowerCase().split(/[\\/]+/);
  const matched = parts.find((part) => ignoredDirectoryNames.has(part));
  return matched ? `Managed/system directory skipped: ${matched}` : null;
}

function getFileSkipReason(name: string): string | null {
  const lowerName = name.toLowerCase();
  if (ignoredFileNames.has(lowerName)) return "Metadata/lock file skipped";
  const extension = path.extname(lowerName);
  if (ignoredFileExtensions.has(extension)) return `Low-value generated file skipped: ${extension}`;
  return null;
}

function recordSkipped(
  skipped: ScanResult["skipped"],
  counters: ScanCounters,
  filePath: string,
  reason: string
) {
  counters.skipped += 1;
  if (skipped.length < 500) {
    skipped.push({ path: filePath, reason });
  }
}

function emitProgressThrottled(
  options: ScanOptions,
  counters: ScanCounters,
  phase: ScannerProgress["phase"],
  currentPath: string | null,
  rootsTotal: number,
  rootsDone: number
) {
  const now = Date.now();
  if (now - counters.lastProgressAt < 120 && counters.scannedFiles % 50 !== 0) return;
  emitProgress(options, counters, phase, currentPath, rootsTotal, rootsDone);
}

function emitProgress(
  options: ScanOptions,
  counters: ScanCounters,
  phase: ScannerProgress["phase"],
  currentPath: string | null,
  rootsTotal: number,
  rootsDone: number,
  message?: string
) {
  counters.lastProgressAt = Date.now();
  options.onProgress?.({
    phase,
    currentPath,
    scannedFiles: counters.scannedFiles,
    indexedFiles: counters.indexedFiles,
    skipped: counters.skipped,
    summarized: counters.summarized,
    rootsTotal,
    rootsDone,
    message
  });
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScanCanceledError();
}

async function getDiskInfo(targetPath: string): Promise<{ total: number | null; free: number | null }> {
  try {
    const stats = await fs.statfs(targetPath);
    const blockSize = Number(stats.bsize);
    return {
      total: Number(stats.blocks) * blockSize,
      free: Number(stats.bavail) * blockSize
    };
  } catch {
    return { total: null, free: null };
  }
}

function findSourceRoot(directory: string): string {
  const home = os.homedir();
  const relative = path.relative(home, directory);
  const firstPart = relative.split(/[\\/]+/).filter(Boolean)[0];
  return firstPart ? path.join(home, firstPart) : directory;
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
