# File Manager Assistant

本地优先的个人文件生命周期管理助手。MVP 支持扫描本机默认目录、SQLite 索引、科学分类、规则引擎、整理方案预览，以及用户确认后的移动/重命名执行。

## Features

- Electron + React + TypeScript desktop app.
- SQLite-backed local file index through `sql.js`.
- Default scan roots: `Desktop`, `Downloads`, `Documents`.
- Scientific classification fields: `file_type`, `purpose`, `lifecycle`, `context`, `risk_level`, `suggested_action`.
- Built-in rules plus user custom rule builder.
- Bilingual UI: 中文 / English.
- iOS-inspired light interface with local-first workflow.
- Execution safety: move and rename require preview; delete is not executed in MVP.

## Commands

```bash
npm install
npm run dev
npm test
npm run typecheck
npm run build
```

## Safety Model

- The app does not automatically move files after scan.
- Sensitive files are classified for review and excluded from executable previews.
- Delete suggestions are not executed in this MVP.
- Move and rename operations are logged in `operation_logs`.

