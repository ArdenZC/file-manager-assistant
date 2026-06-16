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
  <img src="https://img.shields.io/badge/Electron-3178C6?style=for-the-badge&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/SQLite_FTS5-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite FTS5" />
</div>

---

## Introduction

> **A local-first personal file lifecycle assistant.**
> Zen Canvas is not a file explorer replacement or a simple classifier. It connects scanning, fast indexing, explainable organization, safe preview execution, and restore records into one controlled local workflow.

## Core Experience

- **Space Scan**: scan user space or selected folders. Project directories are summarized as parent project assets, so configured engineering environments are not casually moved.
- **Top Search**: stays centered in the title bar. Use `Ctrl + K` on Windows and `⌘ K` on macOS; when the main window is closed, the shortcut opens a standalone frosted search box.
- **Smart Organize**: explains suggested destinations through four clear zones: In Use, Archive Ready, Private, and Cleanup.
- **File Library**: browse scan results, status filters, and classification reasons. Use top search for finding a specific file.
- **Preview Execute**: groups plans by main folders and subfolders. Every move, rename, or combined action must be confirmed first.
- **Auto Rules**: built-in rules are stable; user rules can apply globally. The advanced builder stays folded by default.
- **Restore Records**: only restores operations executed by Zen Canvas, grouped by batch and kept for 15 days by default.

## Search

- Local SQLite + FTS5 indexing, with no dependency on Everything, Spotlight, or OS search backends.
- Supports filename search, path search, tokenized terms, and extension filters.
- Ranking combines relevance, recent modification, recent opens, and path depth.
- Results can open files, reveal them in the system file manager, or open File Library details.
- Dedicated 100k simulated-index performance test targets `<100ms` query latency.

## Safety

- The app does not scan automatically on launch. Scanning only creates an index and suggestions.
- Deletion is suggestion-only in the MVP.
- Sensitive files show advice and reasons, but are not selected for execution.
- Conflicts, low-confidence items, and close rule scores enter manual confirmation by default.
- The execution layer revalidates operation type, absolute paths, safe filenames, source-path consistency, protected system targets, and overwrite conflicts.
- Electron uses `contextIsolation`, disables `nodeIntegration`, enables sandboxing, and blocks unexpected navigation, popups, and permission prompts.

## Architecture

```text
React 19 UI
  -> Secure Preload IPC
    -> Electron Main Process
      -> SQLite WAL + FTS5
      -> Chokidar stale-source watcher
      -> guarded move / rename executor
```

## Development

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run test:performance
npm run build
npm run security:audit
```

Full release verification:

```bash
npm run verify
```

## Packaging

Zen Canvas currently ships unsigned public builds for Windows and macOS. Signing hooks are reserved for later.

```bash
npm run assets:brand
npm run dist:win
npm run dist:mac
```

Release targets:

- Windows: NSIS + zip, `x64` / `ia32` / `arm64`
- macOS: dmg + zip, `x64` / `arm64`

The `.github/workflows/release-build.yml` workflow builds release packages for `v*` tags and attaches them to GitHub Releases.
