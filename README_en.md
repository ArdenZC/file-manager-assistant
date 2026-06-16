Zen Canvas

🌌 Introduction

A local-first file lifecycle assistant for personal desktops.
It is not a raw file explorer replacement, nor a cold command-line classifier. It seamlessly connects workspace scanning, indexing, cognitive understanding, secure previews, and rollback logs into a completely safe local loop.

🎨 Spatial Aesthetics & Glassmorphism

Holographic Radar Decoupling: The main scanner dashboard houses a dynamic Conic-Gradient scanner and metrics to visually diagnose clutter ratio with raw physical feedback.

Apple VisionOS Material: The workspace uses heavily blurred, high-saturation glass structures and a 3-track moving drift ambient lighting system, adapting flawlessly to dark/light themes.

Spotlight-grade Search Bar: Floating at the top-center of the app, instantly summoned via Ctrl/Cmd + K. Fueled by a native SQLite FTS5 engine, offering 100k-level query matching in <100ms.

🔮 Core Dispatched Zones

Zen Canvas automatically distributes suggestions into four tailored logical areas:

📂 Dispatch Zone

💎 Targeted Asset Type

🛡️ Safety & Execution Strategy

Core Assets

Active projects, study notes, career portfolios

Structured and routed to active working directories.

Quiet Archive

Historical invoices, receipts, old backup zip files

Suggested to be relocated to the Archive Glacier.

Privacy Vault

Passport scans, ID documents, credential files

Advice-only in this version. Safe bounds forbid automatic moving.

Cleanup Lane

Expired installers (.exe/.dmg), stray screenshots

Grouped into the disposable queue. No deletion execution in MVP.

⚙️ Architecture

                     ┌────────────────────────────────────────┐
                     │          React 19 Rendering UI         │
                     │  (Glacier Light & Deep Sea Dark Mode)  │
                     └───────────────────┬────────────────────┘
                                         │ IPC Invoke (Secure Context)
                                         ▼
                     ┌────────────────────────────────────────┐
                     │          Preload.ts (Sandbox)          │
                     └───────────────────┬────────────────────┘
                                         │ Electron IPC Channel
                                         ▼
                     ┌────────────────────────────────────────┐
                     │      Electron 42 Main Process (Node)   │
                     └──────┬──────────────────────────┬──────┘
                            │                          │
                            ▼                          ▼
               ┌────────────────────────┐  ┌────────────────────────┐
               │    Local SQLite WAL    │  │  Chokidar File Watcher │
               │   (FTS5 Search Index)  │  │ (Stale Source Tracker) │
               └────────────────────────┘  └────────────────────────┘


💻 Quick Start

Make sure you have Node.js (>= 22) installed on your machine.

# Clone the repository
git clone [https://github.com/ArdenZC/file-manager-assistant.git](https://github.com/ArdenZC/file-manager-assistant.git)
cd file-manager-assistant

# Install dependencies (recompiles better-sqlite3 binaries locally)
npm install

# Start concurrently Vite & Electron Dev Server
npm run dev

# Run typechecks, unit tests, and performance benchmark suite
npm run verify


🛠️ Packaging & Release

The built-in GitHub Actions CI/CD pipeline (release-build.yml) takes care of generating unsigned portable artifacts on v* tag pushes:

# High quality verification
npm run typecheck       # TypeScript static analysis
npm test                # Logical unit testing
npm run test:performance # Search benchmarking


Build commands for specific targets:

Windows Target: NSIS installer + portable ZIP (x64, ia32, arm64) via npm run dist:win

macOS Target: DMG disk image + ZIP (x64, arm64) via npm run dist:mac
