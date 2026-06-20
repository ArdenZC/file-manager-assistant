# Zen Canvas

<div align="center">
  <img src="docs/banner_zh.svg" width="100%" alt="Zen Canvas Banner" />
</div>

<br />

<div align="center">
  <a href="README_en.md">
    <img src="https://img.shields.io/badge/Switch_To_English_Edition-0f172a?style=for-the-badge" alt="English Edition" />
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

## 简介

> **本地优先的个人文件生命周期管理助手。**
> Zen Canvas 不替代系统资源管理器，也不是简单文件分类器；它把空间扫描、快速索引、智能解释、整理预览、安全执行和恢复记录串成一个可控闭环。

## 核心体验

- **空间扫描**：支持扫描用户空间或通过 Tauri 系统目录选择器选择指定文件夹；项目目录会被识别为父级项目资产，默认不深入移动内部工程文件。
- **顶部搜索**：常驻顶部中央，Windows 使用 `Ctrl + K`，macOS 使用 `⌘ K`；主窗口关闭时可唤起独立毛玻璃搜索框。
- **智能整理**：用“正在使用 / 可归档 / 隐私敏感 / 临时清理”四区解释文件去向，不直接执行真实操作。
- **文件库**：用于查看扫描结果、状态筛选和分类原因；具体找文件优先使用顶部搜索。
- **预览执行**：按主文件夹和子文件夹展示整理方案，所有移动、重命名、移动加重命名都必须先确认。
- **自动规则**：内置规则与用户规则共同参与分类；用户规则由前端规则 store 管理，后续计划迁移到 SQLite。
- **恢复记录**：只恢复 Zen Canvas 自己执行过的操作；operation logs 持久化在 SQLite 中，前端默认加载最近操作记录，后续会补充按天保留与自动清理策略。

## 搜索能力

- 本地 SQLite WAL + FTS5 trigram 索引，不依赖 Everything、Spotlight 或系统搜索服务。
- 支持文件名、路径、空格分词和扩展名过滤。
- 默认搜索和分页查询会排除 stale 文件，避免临时删除事件破坏用户可见状态。
- 批量扫描和大批 watcher upsert 后会执行 SQLite `PRAGMA optimize`，并通过 `search-index-optimized` event 暴露触发来源、耗时和错误信息。
- 结果支持打开文件、系统定位、进入文件库详情。
- 性能验证包含前端架构守卫和真实 SQLite/FTS benchmark。

## 增量索引

- watcher 的 remove / delete 事件只会把文件标记为 stale，不会直接删除 `files` 记录。
- `files` 表记录 `is_stale` 和 `last_seen_at`；搜索、分页、统计和规则执行默认排除 stale 文件。
- create / modify / rename / change 事件会 debounce 后批量 upsert；重新出现的文件会 revive stale 记录。
- watcher upsert 后只对受影响 paths 调用 `execute_rules_for_paths` 做轻量分类，不触发全库规则重跑。
- 大批 watcher upsert 达到阈值时会触发 search index optimize；失败只记录 warning，不影响 upsert。

## 操作日志与恢复

- `execute_moves` 会把批次写入 `operation_batches`，并把 success / failed / skipped 结果写入 `operation_logs`。
- `restore_moves` 会回写 `restore_status`、`restored_at`、`restore_error` 和 `can_restore`。
- 应用启动时会从 SQLite 读取最近 operation logs，恢复记录不再只是 React state。
- execute / restore 成功后会同步更新 `files` 表和 FTS，确保文件库和搜索结果指向真实路径。

## 规则分类

- 分类使用内置规则 + 用户规则；用户规则当前由前端规则 store 管理，尚未迁移到 SQLite。
- `rule_version` 使用稳定 hash，不依赖 `DefaultHasher`。
- `files` 表保存分类指纹：`last_classified_at`、`classified_rule_version`、`last_classified_mtime`、`last_classified_size`。
- `execute_rules_on_inbox` 只处理 `lifecycle = Inbox` 且 `is_stale = 0` 的文件，并跳过 rule version、mtime、size 都未变化的记录。
- `RuleExecutionSummary` 会返回 `skipped`，便于区分已扫描候选和实际重分类数量。

## 安全边界

- 启动不自动扫描，扫描只建立索引和建议。
- MVP 不执行删除；删除只作为建议。
- 敏感文件只显示建议和原因，不生成默认可执行勾选。
- 冲突、低置信、规则接近项默认进入待确认队列。
- Tauri command 层会再次校验移动、重命名和恢复操作的类型、绝对路径、安全文件名、源路径一致性、系统目录和覆盖冲突。
- watcher 删除事件只标记 stale，不直接破坏索引历史。
- execute / restore 后会同步更新 `files` 表和 FTS。
- search index optimize 失败只记录 warning，不会让扫描或 upsert 失败。
- Tauri CSP 已配置；前端不直接访问文件系统，扫描、索引、移动、重命名和恢复都在 Rust command 层处理。

## 技术架构

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

## 开发

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

`npm run test:performance` 会先执行前端架构守卫，再运行 Rust SQLite/FTS benchmark。默认 benchmark 会在临时 SQLite 数据库中插入 100,000 条模拟索引，批量写入后执行 SQLite optimize，覆盖 `resume` / `invoice` / `screenshot` / `project` / `身份证` / `report` / `archive` 查询，并检查 p95 查询耗时不超过 1,000ms。benchmark 使用临时 DB，不污染用户数据；ignored Rust benchmark 不会在普通 `cargo test` 中运行。

```bash
npm run test:performance
ZC_BENCH_ROWS=50000 ZC_BENCH_P95_MS=1000 npm run test:performance
```

在 PowerShell 中可用：

```powershell
$env:ZC_BENCH_ROWS="50000"; $env:ZC_BENCH_P95_MS="1000"; npm run test:performance
```

设置 `ZC_BENCH_EXPLAIN=1` 可输出 SQLite query plan。

完整发布前验证：

```bash
npm run verify
```

## 打包与发布

本项目已迁移到 Tauri 2，当前打包入口为 Tauri 构建。默认构建会生成当前平台的桌面应用和安装包；签名配置后续预留。

```bash
npm run assets:brand
npm run build
```

Windows 构建会输出 NSIS 安装包到 `src-tauri/target/release/bundle/nsis/`。跨平台发布矩阵和签名流程会随 Tauri 发布配置继续完善。
