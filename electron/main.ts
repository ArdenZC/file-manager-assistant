import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { Database } from "../src/core/database.js";
import { scanDefaultRoots } from "../src/core/fileScanner.js";
import { executeOperations } from "../src/core/operationExecutor.js";
import { applyAllRulesToFiles } from "../src/core/ruleEngine.js";
import type { ExecuteOperationRequest, FileQuery, Rule } from "../src/types/domain.js";

let mainWindow: BrowserWindow | null = null;
let db: Database;

const isDev = process.env.VITE_DEV_SERVER_URL || process.env.NODE_ENV === "development";

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 720,
    title: "File Manager Assistant",
    backgroundColor: "#f6f8fb",
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist-electron/electron/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (isDev) {
    await mainWindow.loadURL("http://127.0.0.1:5173");
  } else {
    await mainWindow.loadFile(path.join(app.getAppPath(), "dist/index.html"));
  }
}

function registerIpc() {
  ipcMain.handle("app:getSnapshot", async () => db.getSnapshot());

  ipcMain.handle("scan:defaults", async () => {
    const result = await scanDefaultRoots();
    const rules = db.getRules();
    const classified = applyAllRulesToFiles(result.files, rules);
    db.upsertFiles(classified);
    db.upsertScanRoots(result.roots);
    return { ...result, files: classified };
  });

  ipcMain.handle("files:query", async (_event, query: FileQuery) => db.queryFiles(query));

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
    const classified = applyAllRulesToFiles(files, rules);
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

  ipcMain.handle("shell:revealPath", async (_event, targetPath: string) => {
    await shell.showItemInFolder(targetPath);
  });
}

app.whenReady().then(async () => {
  db = await Database.open(app.getPath("userData"));
  registerIpc();
  await createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

