import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function assert(condition, message) {
  if (!condition) {
    console.error(`Architecture guard failed: ${message}`);
    process.exitCode = 1;
  }
}

const viewFiles = [
  "src/views/hub/HubView.tsx",
  "src/views/restore/RestoreView.tsx",
  "src/views/rules/RulesView.tsx",
  "src/views/scanner/ScannerView.tsx",
  "src/views/settings/SettingsView.tsx",
  "src/views/timeline/TimelineView.tsx",
  "src/views/vault/AssetCard.tsx",
  "src/views/vault/VaultView.tsx"
];
const appViews = viewFiles.map(read).join("\n");
const app = read("src/App.tsx");
const appShell = read("src/components/AppShell.tsx");
const runtimeUi = [app, appShell, appViews].join("\n");
const api = read("src/api/tauriApi.ts");
const dbFiles = [
  "src-tauri/src/db/commands.rs",
  "src-tauri/src/db/connection.rs",
  "src-tauri/src/db/mod.rs",
  "src-tauri/src/db/schema.rs",
  "src-tauri/src/db/types.rs",
  "src-tauri/src/db/classification/builtin_rules.rs",
  "src-tauri/src/db/classification/engine.rs",
  "src-tauri/src/db/classification/mod.rs",
  "src-tauri/src/db/classification/naming.rs",
  "src-tauri/src/db/queries/files.rs",
  "src-tauri/src/db/queries/mod.rs",
  "src-tauri/src/db/queries/operations.rs",
  "src-tauri/src/db/queries/rules_repo.rs"
];
const db = dbFiles.map(read).join("\n");

assert(api.includes("getPagedFiles"), "Tauri API must expose getPagedFiles.");
assert(api.includes("getStatsSummary"), "Tauri API must expose getStatsSummary.");
assert(!api.includes("fetchDatabase"), "Tauri API must not expose giant fetchDatabase.");
assert(!db.includes("fetch_database"), "Rust backend must not register fetch_database.");
assert(appViews.includes("IntersectionObserver"), "File library must lazy-load with IntersectionObserver.");
assert(appViews.includes("LIBRARY_PAGE_SIZE = 50"), "File library page size should remain bounded at 50.");
assert(!runtimeUi.includes("demoData"), "Runtime UI must not depend on demo data.");
assert(!runtimeUi.includes("window.fileManager"), "Runtime UI must not depend on Electron preload APIs.");
assert(!runtimeUi.includes("snapshot"), "Runtime UI must not keep an all-files snapshot.");

if (!process.exitCode) {
  console.log("Architecture guard passed: paged IPC, bounded library loading, and no legacy full snapshot path.");
} else {
  process.exit(process.exitCode);
}

console.log("Running SQLite/FTS benchmark...");

const benchmark = spawnSync(
  "cargo",
  [
    "test",
    "--release",
    "--manifest-path",
    "src-tauri/Cargo.toml",
    "fts_benchmark_100k",
    "--",
    "--ignored",
    "--nocapture",
  ],
  {
    cwd: root,
    stdio: "inherit",
  },
);

if (benchmark.error) {
  console.error(`SQLite/FTS benchmark failed to start: ${benchmark.error.message}`);
  process.exit(1);
}

if (benchmark.status !== 0) {
  console.error(`SQLite/FTS benchmark failed with exit code ${benchmark.status}.`);
  process.exit(benchmark.status ?? 1);
}

console.log("SQLite/FTS benchmark passed.");
