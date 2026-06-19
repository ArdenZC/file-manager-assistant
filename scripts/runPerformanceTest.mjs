import fs from "node:fs";
import path from "node:path";

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

const appViews = read("src/views/AppViews.tsx");
const app = read("src/App.tsx");
const api = read("src/api/tauriApi.ts");
const db = read("src-tauri/src/db.rs");

assert(api.includes("getPagedFiles"), "Tauri API must expose getPagedFiles.");
assert(api.includes("getStatsSummary"), "Tauri API must expose getStatsSummary.");
assert(!api.includes("fetchDatabase"), "Tauri API must not expose giant fetchDatabase.");
assert(!db.includes("fetch_database"), "Rust backend must not register fetch_database.");
assert(appViews.includes("IntersectionObserver"), "File library must lazy-load with IntersectionObserver.");
assert(appViews.includes("LIBRARY_PAGE_SIZE = 50"), "File library page size should remain bounded at 50.");
assert(!app.includes("demoData") && !appViews.includes("demoData"), "Runtime UI must not depend on demo data.");
assert(!app.includes("window.fileManager") && !appViews.includes("window.fileManager"), "Runtime UI must not depend on Electron preload APIs.");
assert(!app.includes("snapshot") && !appViews.includes("snapshot"), "Runtime UI must not keep an all-files snapshot.");

if (!process.exitCode) {
  console.log("Architecture guard passed: paged IPC, bounded library loading, and no legacy full snapshot path.");
}
