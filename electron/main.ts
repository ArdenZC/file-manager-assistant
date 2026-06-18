import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, nativeTheme, screen, session, shell, Tray } from "electron";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "chokidar";
import { Database } from "../src/core/database.js";
import { scanRoots, ScanCanceledError } from "../src/core/fileScanner.js";
import { executeOperations } from "../src/core/operationExecutor.js";
import { createRestorePreview, restoreBatch } from "../src/core/restoreExecutor.js";
import { applyAllRulesToFiles } from "../src/core/ruleEngine.js";
import type {
  CloseBehavior,
  DefaultScanFolder,
  ExecuteOperationRequest,
  FileQuery,
  FolderNamingLanguage,
  RestoreRetentionDays,
  Rule,
  ScanProgress,
  ScanResult,
  SearchQuery,
  SearchSource
} from "../src/types/domain.js";

let mainWindow: BrowserWindow | null = null;
let searchWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let db: Database;
let searchWatcher: ReturnType<typeof watch> | null = null;
let registeredSearchHotkey = "CommandOrControl+K";
let isQuitting = false;
let suppressSearchStaleUntil = 0;
let staleNotifyTimer: NodeJS.Timeout | null = null;
let currentScanAbort: AbortController | null = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev: boolean = Boolean(process.env.VITE_DEV_SERVER_URL) || process.env.NODE_ENV === "development";
const appIconPath = path.join(__dirname, "../../build/icon.png");
const appDarkIconPath = path.join(__dirname, "../../build/icon-dark.png");
const searchWindowSize = { width: 760, height: 520 };
const defaultScanFolderOptions: DefaultScanFolder[] = ["Desktop", "Downloads", "Documents"];

function currentAppIconPath() {
  return nativeTheme.shouldUseDarkColors ? appDarkIconPath : appIconPath;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: "Zen Canvas",
    icon: process.platform === "darwin" ? undefined : currentAppIconPath(),
    backgroundColor: "#0a0f1a",
    frame: process.platform === "darwin",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const expectedDevUrl = isDev && url.startsWith("http://127.0.0.1:5173");
    const expectedFileUrl = !isDev && url.startsWith("file://");
    if (!expectedDevUrl && !expectedFileUrl) {
      event.preventDefault();
    }
  });

  if (isDev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.join(__dirname, "../../dist/index.html"));
  }

  mainWindow.on("close", (event) => {
    if (isQuitting || process.platform === "darwin") return;
    const closeBehavior = getCloseBehavior();
    if (closeBehavior === "quit") return;
    event.preventDefault();
    if (closeBehavior === "minimize" || db.getSetting("backgroundResident") === "true") {
      mainWindow?.hide();
      return;
    }
    mainWindow?.webContents.send("app:close-requested");
  });

  mainWindow.on("minimize" as never, (event: Electron.Event) => {
    if (process.platform !== "win32" || isQuitting) return;
    event.preventDefault();
    hideMainWindow();
  });
}

function hideMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.hide();
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    void createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createTray() {
  if (process.platform === "darwin" || tray) return;
  tray = new Tray(currentAppIconPath());
  tray.setToolTip("Zen Canvas");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Zen Canvas", click: showMainWindow },
    { label: "搜索文件", click: () => void showSearch() },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  ]));
  tray.on("click", showMainWindow);
}

function getCloseBehavior(): CloseBehavior {
  const value = db?.getSetting("closeBehavior");
  return value === "minimize" || value === "quit" ? value : "ask";
}

function getFolderNamingLanguage(): FolderNamingLanguage {
  return db?.getFolderNamingLanguage() ?? "en";
}

function applyClassification(files: Parameters<typeof applyAllRulesToFiles>[0], rules: Rule[]) {
  return applyAllRulesToFiles(files, rules, { folderNamingLanguage: getFolderNamingLanguage() });
}

function getDefaultScanFolders(): DefaultScanFolder[] {
  const raw = db?.getSetting("defaultScanFolders");
  if (!raw) return defaultScanFolderOptions;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return defaultScanFolderOptions;
    const valid = parsed.filter((item): item is DefaultScanFolder =>
      defaultScanFolderOptions.includes(item as DefaultScanFolder)
    );
    return valid.length ? valid : defaultScanFolderOptions;
  } catch {
    return defaultScanFolderOptions;
  }
}

function normalizeDefaultScanFolders(folders: DefaultScanFolder[]): DefaultScanFolder[] {
  const seen = new Set<DefaultScanFolder>();
  for (const folder of folders) {
    if (defaultScanFolderOptions.includes(folder)) seen.add(folder);
  }
  return seen.size ? [...seen] : defaultScanFolderOptions;
}

function getDefaultScanPaths(): string[] {
  const home = os.homedir();
  return getDefaultScanFolders().map((folder) => path.join(home, folder));
}

function normalizeRestoreRetentionDays(days: number): RestoreRetentionDays {
  return days === 15 || days === 60 || days === 90 ? days : 30;
}

function rebuildSearchIndexClean() {
  const state = db.rebuildSearchIndex();
  suppressSearchStaleUntil = Date.now() + 3000;
  clearPendingStaleNotify();
  return state;
}

function clearPendingStaleNotify() {
  if (staleNotifyTimer) {
    clearTimeout(staleNotifyTimer);
    staleNotifyTimer = null;
  }
}

function positionSearchWindow() {
  if (!searchWindow || searchWindow.isDestroyed()) return;
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.workArea;
  const targetX = Math.round(x + (width - searchWindowSize.width) / 2);
  const targetY = Math.round(y + Math.max(32, height * 0.16));
  searchWindow.setPosition(targetX, targetY, false);
}

function refreshWindowIcons() {
  if (process.platform === "darwin") return;
  const icon = currentAppIconPath();
  for (const window of BrowserWindow.getAllWindows()) {
    window.setIcon(icon);
  }
  tray?.setImage(icon);
}

async function scanAndIndexPaths(
  sender: Electron.WebContents,
  rootPaths: string[]
): Promise<ScanResult> {
  currentScanAbort?.abort();
  const controller = new AbortController();
  currentScanAbort = controller;
  const scanId = `scan-${Date.now().toString(36)}`;
  const startedAt = new Date().toISOString();

  try {
    const result = await scanRoots(rootPaths, {
      signal: controller.signal,
      onProgress: (progress) => sendScanProgress(sender, scanId, progress)
    });
    throwIfScanCanceled(controller);
    sendScanProgress(sender, scanId, {
      phase: "indexing",
      currentPath: null,
      scannedFiles: result.files.length,
      indexedFiles: 0,
      skipped: result.skipped.length,
      summarized: result.roots.reduce((sum, root) => sum + Number(root.summarized_count ?? 0), 0),
      rootsTotal: result.roots.length,
      rootsDone: result.roots.length,
      message: "Applying rules"
    });
    const rules = db.getRules();
    const classified = applyClassification(result.files, rules);
    throwIfScanCanceled(controller);
    db.upsertScanRoots(result.roots);
    db.replaceFilesForRoots(result.roots, classified);
    rebuildSearchIndexClean();
    await refreshSearchWatcher();
    sendScanProgress(sender, scanId, {
      phase: "done",
      currentPath: null,
      scannedFiles: classified.length,
      indexedFiles: classified.length,
      skipped: result.skipped.length,
      summarized: result.roots.reduce((sum, root) => sum + Number(root.summarized_count ?? 0), 0),
      rootsTotal: result.roots.length,
      rootsDone: result.roots.length,
      message: "Scan completed"
    });
    return { ...result, files: classified };
  } catch (error) {
    if (error instanceof ScanCanceledError || controller.signal.aborted) {
      sendScanProgress(sender, scanId, {
        phase: "canceled",
        currentPath: null,
        scannedFiles: 0,
        indexedFiles: 0,
        skipped: 0,
        summarized: 0,
        rootsTotal: rootPaths.length,
        rootsDone: 0,
        message: "Scan canceled"
      });
      return {
        roots: [],
        files: [],
        skipped: [],
        scannedAt: startedAt,
        canceled: true
      };
    }
    sendScanProgress(sender, scanId, {
      phase: "error",
      currentPath: null,
      scannedFiles: 0,
      indexedFiles: 0,
      skipped: 0,
      summarized: 0,
      rootsTotal: rootPaths.length,
      rootsDone: 0,
      message: error instanceof Error ? error.message : String(error)
    });
    throw error;
  } finally {
    if (currentScanAbort === controller) {
      currentScanAbort = null;
    }
  }
}

function sendScanProgress(
  sender: Electron.WebContents,
  scanId: string,
  progress: Omit<ScanProgress, "scanId">
) {
  if (sender.isDestroyed()) return;
  sender.send("scan:progress", { scanId, ...progress });
}

function throwIfScanCanceled(controller: AbortController) {
  if (controller.signal.aborted) throw new ScanCanceledError();
}

async function createSearchWindow() {
  if (searchWindow && !searchWindow.isDestroyed()) {
    positionSearchWindow();
    searchWindow.show();
    searchWindow.focus();
    searchWindow.webContents.send("command:open");
    return;
  }

  searchWindow = new BrowserWindow({
    width: searchWindowSize.width,
    height: searchWindowSize.height,
    minWidth: 520,
    minHeight: 96,
    title: "Zen Canvas Search",
    frame: false,
    resizable: false,
    movable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    hasShadow: false,
    icon: process.platform === "darwin" ? undefined : currentAppIconPath(),
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false
    }
  });

  searchWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  searchWindow.on("closed", () => {
    searchWindow = null;
  });
  searchWindow.on("blur", () => {
    searchWindow?.hide();
  });

  if (isDev) {
    await searchWindow.loadURL("http://127.0.0.1:5173?mode=search");
  } else {
    await searchWindow.loadFile(path.join(__dirname, "../../dist/index.html"), {
      query: { mode: "search" }
    });
  }

  positionSearchWindow();
  searchWindow.show();
  searchWindow.focus();
}

function registerIpc() {
  ipcMain.handle("app:getSnapshot", async () => db.getSnapshot());

  ipcMain.handle("scan:defaults", async (event) => {
    return scanAndIndexPaths(event.sender, getDefaultScanPaths());
  });

  ipcMain.handle("scan:chooseFolders", async (event) => {
    const dialogOptions: Electron.OpenDialogOptions = {
      title: "Choose folders to scan",
      properties: ["openDirectory", "multiSelections"]
    };
    const selected = mainWindow
      ? await dialog.showOpenDialog(mainWindow, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);

    if (selected.canceled || selected.filePaths.length === 0) {
      return {
        canceled: true,
        selectedPaths: [],
        roots: [],
        files: [],
        skipped: [],
        scannedAt: new Date().toISOString()
      };
    }

    const result = await scanAndIndexPaths(event.sender, selected.filePaths);
    return { ...result, canceled: Boolean(result.canceled), selectedPaths: selected.filePaths };
  });

  ipcMain.handle("scan:cancel", async () => {
    const hadScan = Boolean(currentScanAbort);
    currentScanAbort?.abort();
    return hadScan;
  });

  ipcMain.handle("files:query", async (_event, query: FileQuery) => db.queryFilesPage(query));

  ipcMain.handle("search:query", async (_event, query: SearchQuery) => db.searchFiles(query));

  ipcMain.handle("search:openResult", async (_event, fileId: string) => {
    const file = db.getFileById(fileId);
    if (!file || !path.isAbsolute(file.path)) return { ok: false, error: "File not found" };
    db.recordFileOpened(file.id);
    const error = await shell.openPath(file.path);
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle("search:revealResult", async (_event, fileId: string) => {
    const file = db.getFileById(fileId);
    if (!file || !path.isAbsolute(file.path)) return { ok: false, error: "File not found" };
    db.recordFileOpened(file.id);
    shell.showItemInFolder(file.path);
    return { ok: true };
  });

  ipcMain.handle("search:getSources", async () => db.getSearchSources());

  ipcMain.handle("search:updateSources", async (_event, sources: SearchSource[]) => {
    db.updateSearchSources(sources);
    await refreshSearchWatcher();
    return db.getSearchSources();
  });

  ipcMain.handle("search:rebuildIndex", async () => rebuildSearchIndexClean());

  ipcMain.handle("search:getHotkey", async () => db.getSetting("searchHotkey") ?? registeredSearchHotkey);

  ipcMain.handle("search:setHotkey", async (_event, accelerator: string) => {
    const ok = registerSearchHotkey(accelerator);
    if (ok) db.setSetting("searchHotkey", accelerator);
    return { ok, hotkey: registeredSearchHotkey };
  });

  ipcMain.handle("search:show", async () => {
    await showSearch();
    return true;
  });

  ipcMain.handle("search:hide", async () => {
    searchWindow?.hide();
    mainWindow?.webContents.send("command:hide");
    return true;
  });

  ipcMain.handle("settings:getBackgroundResident", async () => db.getSetting("backgroundResident") === "true");

  ipcMain.handle("settings:setBackgroundResident", async (_event, enabled: boolean) => {
    db.setSetting("backgroundResident", enabled ? "true" : "false");
    return enabled;
  });

  ipcMain.handle("settings:getLaunchAtLogin", async () => app.getLoginItemSettings().openAtLogin);

  ipcMain.handle("settings:setLaunchAtLogin", async (_event, enabled: boolean) => {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      openAsHidden: true
    });
    return app.getLoginItemSettings().openAtLogin;
  });

  ipcMain.handle("settings:getCloseBehavior", async () => getCloseBehavior());

  ipcMain.handle("settings:setCloseBehavior", async (_event, behavior: CloseBehavior) => {
    const normalized: CloseBehavior = behavior === "minimize" || behavior === "quit" ? behavior : "ask";
    db.setSetting("closeBehavior", normalized);
    return normalized;
  });

  ipcMain.handle("settings:getFolderNamingLanguage", async () => getFolderNamingLanguage());

  ipcMain.handle("settings:setFolderNamingLanguage", async (_event, language: FolderNamingLanguage) => {
    const normalized: FolderNamingLanguage = language === "zh" ? "zh" : "en";
    db.setSetting("folderNamingLanguage", normalized);
    return normalized;
  });

  ipcMain.handle("settings:getDefaultScanFolders", async () => getDefaultScanFolders());

  ipcMain.handle("settings:setDefaultScanFolders", async (_event, folders: DefaultScanFolder[]) => {
    const normalized = normalizeDefaultScanFolders(folders);
    db.setSetting("defaultScanFolders", JSON.stringify(normalized));
    return normalized;
  });

  ipcMain.handle("settings:getRestoreRetentionDays", async () => db.getRestoreRetentionDays());

  ipcMain.handle("settings:setRestoreRetentionDays", async (_event, days: number) => {
    const normalized = normalizeRestoreRetentionDays(days);
    db.setSetting("restoreRetentionDays", String(normalized));
    db.pruneOperationLogs(normalized);
    return normalized;
  });

  ipcMain.handle("rules:save", async (_event, rule: Rule) => {
    db.saveRule(rule);
    return db.getRules();
  });

  ipcMain.handle("rules:delete", async (_event, id: string) => {
    db.deleteRule(id);
    return db.getRules();
  });

  ipcMain.handle("rules:reapply", async () => {
    const files = db.getAllFiles();
    const rules = db.getRules();
    const classified = applyClassification(files, rules);
    db.upsertFiles(classified);
    return db.getSnapshot();
  });

  ipcMain.handle("operations:execute", async (_event, request: ExecuteOperationRequest) => {
    const files = db.getAllFiles();
    const result = await executeOperations(files, request.operations);
    db.addOperationLogs(result.logs);
    db.upsertFiles(result.updatedFiles);
    return result;
  });

  ipcMain.handle("operations:restoreBatches", async () => db.getRestoreBatches());

  ipcMain.handle("operations:restorePreview", async (_event, batchId: string) => {
    const logs = db.getOperationLogsByBatch(batchId);
    return createRestorePreview(logs);
  });

  ipcMain.handle("operations:restoreBatch", async (_event, batchId: string) => {
    const logs = db.getOperationLogsByBatch(batchId);
    const result = await restoreBatch(logs);
    for (const item of result.items) {
      if (item.blocking_reason === "Restored") {
        db.markRestoreResult(item.log_id, "restored", null);
      } else if (item.blocking_reason && item.blocking_reason !== "Already restored") {
        db.markRestoreResult(item.log_id, item.can_restore ? "not_restored" : "failed", item.blocking_reason);
      }
    }
    return result;
  });

  ipcMain.handle("shell:revealPath", async (_event, targetPath: string) => {
    if (!targetPath || !path.isAbsolute(targetPath)) return false;
    const resolvedPath = path.resolve(targetPath);
    if (!isSubpathOrSame(resolvedPath, app.getPath("home"))) return false;
    shell.showItemInFolder(resolvedPath);
    return true;
  });

  ipcMain.handle("app:windowControl", (event, action: "minimize" | "maximize" | "close") => {
    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return false;
    if (action === "minimize") window.minimize();
    if (action === "maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    }
    if (action === "close") window.close();
    return true;
  });

  ipcMain.handle("app:performClose", async (_event, action: "minimize" | "quit") => {
    if (action === "minimize") {
      hideMainWindow();
      return true;
    }
    isQuitting = true;
    app.quit();
    return true;
  });
}

async function showSearch() {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("command:open");
    return;
  }
  await createSearchWindow();
}

function registerSearchHotkey(accelerator: string): boolean {
  const normalized = accelerator.trim() || "CommandOrControl+K";
  if (registeredSearchHotkey) {
    globalShortcut.unregister(registeredSearchHotkey);
  }
  const ok = globalShortcut.register(normalized, () => {
    void showSearch();
  });
  if (ok) {
    registeredSearchHotkey = normalized;
    return true;
  }
  globalShortcut.register(registeredSearchHotkey, () => {
    void showSearch();
  });
  return false;
}

function isSubpathOrSame(childPath: string, parentPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function refreshSearchWatcher() {
  await searchWatcher?.close();
  searchWatcher = null;
  const sources = db.getSearchSources().filter((source) => source.enabled);
  const paths = sources.map((source) => source.path);
  if (!paths.length) return;
  searchWatcher = watch(paths, {
    ignoreInitial: true,
    depth: 8,
    ignorePermissionErrors: true,
    ignored: (targetPath) => shouldIgnoreWatchPath(String(targetPath))
  });
  const markStale = (changedPath: string) => {
    if (Date.now() < suppressSearchStaleUntil) return;
    db.markSearchSourceStaleByPath(changedPath);
    scheduleStaleNotify();
  };
  searchWatcher.on("add", markStale);
  searchWatcher.on("change", markStale);
  searchWatcher.on("unlink", markStale);
  searchWatcher.on("unlinkDir", markStale);
  searchWatcher.on("error", () => undefined);
}

function scheduleStaleNotify() {
  clearPendingStaleNotify();
  staleNotifyTimer = setTimeout(() => {
    staleNotifyTimer = null;
    const state = db.getSearchIndexState();
    mainWindow?.webContents.send("search:stale", state);
    searchWindow?.webContents.send("search:stale", state);
  }, 1200);
}

function shouldIgnoreWatchPath(targetPath: string): boolean {
  return /(^|[\\/])(\.git|node_modules|AppData|Application Data|Library|System32|Windows|WindowsApps|ProgramData|System Volume Information|\$Recycle\.Bin)([\\/]|$)/i
    .test(targetPath);
}

app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
      callback(false);
    });

    db = await Database.open(app.getPath("userData"));
    registerIpc();
    await createWindow();
    createTray();
    refreshWindowIcons();
    nativeTheme.on("updated", refreshWindowIcons);
    registerSearchHotkey(db.getSetting("searchHotkey") ?? "CommandOrControl+K");
    await refreshSearchWatcher();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        void createWindow();
      }
    });
  } catch (error) {
    console.error("[Zen Canvas] Startup failed:", error);
    dialog.showErrorBox("Zen Canvas startup failed", error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" && db?.getSetting("backgroundResident") !== "true") {
    app.quit();
  }
});

app.on("will-quit", () => {
  isQuitting = true;
  currentScanAbort?.abort();
  clearPendingStaleNotify();
  globalShortcut.unregisterAll();
  searchWindow?.destroy();
  void searchWatcher?.close();
  tray?.destroy();
});
