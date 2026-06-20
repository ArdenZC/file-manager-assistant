# Zen Canvas

<div align="center">
  <img src="docs/banner_en.svg" width="100%" alt="Zen Canvas Banner" />
</div>

<br />

<div align="center">
  <a href="README.md">
    <img src="https://img.shields.io/badge/切换到中文版本-0f172a?style=for-the-badge" alt="中文版本" />
  </a>
</div>

<div align="center">
  <img src="https://img.shields.io/badge/Tauri_2-24C8DB?style=for-the-badge&logo=tauri&logoColor=white" alt="Tauri 2" />
  <img src="https://img.shields.io/badge/Rust-000000?style=for-the-badge&logo=rust&logoColor=white" alt="Rust" />
  <img src="https://img.shields.io/badge/React_19-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Vite_8-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite 8" />
  <img src="https://img.shields.io/badge/Tailwind_CSS_4-06B6D4?style=for-the-badge&logo=tailwindcss&logoColor=white" alt="Tailwind CSS 4" />
  <img src="https://img.shields.io/badge/SQLite_FTS5-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite FTS5" />
</div>

---

## Introduction

> **A local-first personal file lifecycle assistant.**
> Zen Canvas is not a file explorer replacement or a simple classifier. It connects scanning, fast indexing, explainable organization, safe preview execution, and restore records into one controlled local workflow.

## Core Experience

- **Space Scan**: scan user space or selected folders through the Tauri system directory picker. Project directories are summarized as parent project assets, so configured engineering environments are not casually moved.
- **Top Search**: stays centered in the title bar. Use `Ctrl + K` on Windows and `⌘ K` on macOS; when the main window is closed, the shortcut opens a standalone frosted search box.
- **Smart Organize**: explains suggested destinations through four clear zones: In Use, Archive Ready, Private, and Cleanup.
- **File Library**: browse scan results, status filters, and classification reasons. Use top search for finding a specific file.
- **Preview Execute**: groups plans by main folders and subfolders. Every move, rename, or combined action must be confirmed first.
- **Auto Rules**: built-in and user rules both participate in classification. User rules are currently managed by the frontend rule store and are planned for SQLite migration.
- **Restore Records**: only restores operations executed by Zen Canvas. Operation logs are persisted in SQLite, and the frontend loads recent operation records by default; day-based retention and automatic cleanup are planned later.

## Search

- Local SQLite WAL + FTS5 trigram indexing, with no dependency on Everything, Spotlight, or OS search backends.
- Supports filename search, path search, tokenized terms, and extension filters.
- Default search and paged queries exclude stale files, so transient delete events do not destroy the visible library state.
- Bulk scans and large watcher upserts run SQLite `PRAGMA optimize`, then emit a `search-index-optimized` event with trigger, duration, success, and error fields.
- Results can open files, reveal them in the system file manager, or open File Library details.
- Performance validation includes frontend architecture guards and a real SQLite/FTS benchmark.

## Incremental Indexing

- Watcher remove / delete events mark files stale instead of deleting `files` rows.
- The `files` table tracks `is_stale` and `last_seen_at`; search, pagination, stats, and rule execution exclude stale files by default.
- Create / modify / rename / change events are debounced and batch-upserted. Files that reappear can revive stale records.
- After watcher upserts, Zen Canvas runs `execute_rules_for_paths` only for affected paths instead of re-running rules over the full library.
- Large watcher upserts trigger search index optimize at the existing threshold. Optimize failures only log warnings and do not fail the upsert.

## Operation Logs And Restore

- `execute_moves` writes batches to `operation_batches` and writes success / failed / skipped results to `operation_logs`.
- `restore_moves` writes back `restore_status`, `restored_at`, `restore_error`, and `can_restore`.
- App startup reads recent operation logs from SQLite, so restore history is no longer only React state.
- Successful execute / restore operations update the `files` table and FTS so File Library and search results point to the real path.

## Rule Classification

- Classification uses built-in rules plus user rules. User rules are currently managed by the frontend rule store and have not moved to SQLite yet.
- `rule_version` uses a stable hash and no longer relies on `DefaultHasher`.
- The `files` table stores classification fingerprints: `last_classified_at`, `classified_rule_version`, `last_classified_mtime`, and `last_classified_size`.
- `execute_rules_on_inbox` only considers files where `lifecycle = Inbox` and `is_stale = 0`, and skips records whose rule version, mtime, and size have not changed.
- `RuleExecutionSummary` includes `skipped`, making candidate scans and real reclassifications visible separately.

## Safety

- The app does not scan automatically on launch. Scanning only creates an index and suggestions.
- Deletion is suggestion-only in the MVP.
- Sensitive files show advice and reasons, but are not selected for execution.
- Conflicts, low-confidence items, and close rule scores enter manual confirmation by default.
- The Tauri command layer revalidates move, rename, and restore operation type, absolute paths, safe filenames, source-path consistency, protected system targets, and overwrite conflicts.
- Watcher delete events only mark stale records and do not directly destroy index history.
- Execute / restore updates the `files` table and FTS after successful file operations.
- Search index optimize failures only log warnings and do not fail scans or upserts.
- Tauri CSP is configured. The frontend does not access the file system directly; scanning, indexing, moving, renaming, and restore are handled in Rust commands.

## Architecture

```text
React 19 + TypeScript + Tailwind CSS 4 UI
  -> Tauri 2 commands / events
    -> Rust backend
      -> SQLite WAL + FTS5 trigram
      -> r2d2 connection pool
      -> jwalk scanner + notify watcher
      -> stale/upsert incremental indexer
      -> operation log + restore journal
      -> guarded move / rename / restore executor
      -> rule classifier with stable rule version + file fingerprint
      -> PRAGMA optimize after bulk writes
```

## Development

```bash
npm install
npm run dev
npm run typecheck
npm test
cd src-tauri && cargo test && cargo check --features desktop-runtime && cd ..
npm run test:performance
npm run build
npm run security:audit
```

`npm run test:performance` first runs the frontend architecture guard, then runs a Rust SQLite/FTS benchmark. By default, the benchmark inserts 100,000 simulated index rows into a temporary SQLite database, runs SQLite optimize after the bulk write, covers `resume` / `invoice` / `screenshot` / `project` / `身份证` / `report` / `archive` queries, and checks p95 query latency against a 1,000ms threshold. The benchmark uses a temporary DB and does not touch user data; the ignored Rust benchmark does not run during ordinary `cargo test`.

```bash
npm run test:performance
ZC_BENCH_ROWS=50000 ZC_BENCH_P95_MS=1000 npm run test:performance
```

In PowerShell:

```powershell
$env:ZC_BENCH_ROWS="50000"; $env:ZC_BENCH_P95_MS="1000"; npm run test:performance
```

Set `ZC_BENCH_EXPLAIN=1` to print SQLite query plans.

Full release verification:

```bash
npm run verify
```

## Packaging

Zen Canvas has moved to Tauri 2. The current packaging entrypoint is the Tauri build, which produces the desktop app and installer for the current platform. Signing hooks are reserved for later.

```bash
npm run assets:brand
npm run build
```

Windows builds output the NSIS installer under `src-tauri/target/release/bundle/nsis/`. The cross-platform release matrix and signing flow will be refined alongside the Tauri release configuration.
