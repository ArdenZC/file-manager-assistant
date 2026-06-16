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
  <img src="https://img.shields.io/badge/Electron-3178C6?style=for-the-badge&logo=electron&logoColor=white" alt="Electron" />
  <img src="https://img.shields.io/badge/React-61DAFB?style=for-the-badge&logo=react&logoColor=black" alt="React" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/SQLite_FTS5-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite FTS5" />
</div>

---

## 简介

> **本地优先的个人文件生命周期管理助手。**
> Zen Canvas 不替代系统资源管理器，也不是简单文件分类器；它把空间扫描、快速索引、智能解释、整理预览、安全执行和恢复记录串成一个可控闭环。

## 核心体验

- **空间扫描**：支持扫描用户空间或选择指定文件夹；项目目录会被识别为父级项目资产，默认不深入移动内部工程文件。
- **顶部搜索**：常驻顶部中央，Windows 使用 `Ctrl + K`，macOS 使用 `⌘ K`；主窗口关闭时可唤起独立毛玻璃搜索框。
- **智能整理**：用“正在使用 / 可归档 / 隐私敏感 / 临时清理”四区解释文件去向，不直接执行真实操作。
- **文件库**：用于查看扫描结果、状态筛选和分类原因；具体找文件优先使用顶部搜索。
- **预览执行**：按主文件夹和子文件夹展示整理方案，所有移动、重命名、移动加重命名都必须先确认。
- **自动规则**：内置规则不可删除，用户规则可长期生效；高级构建器默认折叠。
- **恢复记录**：只恢复 Zen Canvas 自己执行过的操作，默认按批次保留 15 天。

## 搜索能力

- 本地 SQLite + FTS5 索引，不依赖 Everything、Spotlight 或系统搜索服务。
- 支持文件名、路径、空格分词和扩展名过滤。
- 排序结合相关性、最近修改、最近打开和路径深度。
- 结果支持打开文件、系统定位、进入文件库详情。
- 专用性能测试覆盖 10 万条模拟索引，查询目标 `<100ms`。

## 安全边界

- 启动不自动扫描，扫描只建立索引和建议。
- MVP 不执行删除；删除只作为建议。
- 敏感文件只显示建议和原因，不生成默认可执行勾选。
- 冲突、低置信、规则接近项默认进入待确认队列。
- 执行层会再次校验操作类型、绝对路径、安全文件名、源路径一致性、系统目录和覆盖冲突。
- Electron 启用 `contextIsolation`、禁用 `nodeIntegration`、启用 sandbox，并拒绝异常导航、弹窗和权限请求。

## 技术架构

```text
React 19 UI
  -> Secure Preload IPC
    -> Electron Main Process
      -> SQLite WAL + FTS5
      -> Chokidar stale-source watcher
      -> guarded move / rename executor
```

## 开发

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run test:performance
npm run build
npm run security:audit
```

完整发布前验证：

```bash
npm run verify
```

## 打包与发布

本项目发布 Windows 和 macOS 未签名公开版，后续预留签名配置。

```bash
npm run assets:brand
npm run dist:win
npm run dist:mac
```

发布目标：

- Windows: NSIS + zip, `x64` / `ia32` / `arm64`
- macOS: dmg + zip, `x64` / `arm64`

GitHub Actions 工作流 `.github/workflows/release-build.yml` 会在 `v*` tag 推送时构建软件包，并挂载到 GitHub Release。
