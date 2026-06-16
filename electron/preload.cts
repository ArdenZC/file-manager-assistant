import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSnapshot,
  ExecuteOperationRequest,
  FileQuery,
  FolderScanResult,
  RestoreBatch,
  RestoreBatchResult,
  RestorePreview,
  Rule,
  ScanResult,
  SearchIndexState,
  SearchQuery,
  SearchResult,
  SearchSource
} from "../src/types/domain.js";

const api = {
  platform: process.platform,
  getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke("app:getSnapshot"),
  scanDefaults: (): Promise<ScanResult> => ipcRenderer.invoke("scan:defaults"),
  chooseAndScanFolders: (): Promise<FolderScanResult> => ipcRenderer.invoke("scan:chooseFolders"),
  queryFiles: (query: FileQuery) => ipcRenderer.invoke("files:query", query),
  saveRule: (rule: Rule) => ipcRenderer.invoke("rules:save", rule),
  deleteRule: (id: string) => ipcRenderer.invoke("rules:delete", id),
  reapplyRules: () => ipcRenderer.invoke("rules:reapply"),
  executeOperations: (request: ExecuteOperationRequest) =>
    ipcRenderer.invoke("operations:execute", request),
  getRestoreBatches: (): Promise<RestoreBatch[]> => ipcRenderer.invoke("operations:restoreBatches"),
  getRestorePreview: (batchId: string): Promise<RestorePreview> =>
    ipcRenderer.invoke("operations:restorePreview", batchId),
  restoreBatch: (batchId: string): Promise<RestoreBatchResult> =>
    ipcRenderer.invoke("operations:restoreBatch", batchId),
  searchQuery: (query: SearchQuery): Promise<SearchResult[]> => ipcRenderer.invoke("search:query", query),
  openSearchResult: (fileId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("search:openResult", fileId),
  revealSearchResult: (fileId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("search:revealResult", fileId),
  getSearchSources: (): Promise<SearchSource[]> => ipcRenderer.invoke("search:getSources"),
  updateSearchSources: (sources: SearchSource[]): Promise<SearchSource[]> =>
    ipcRenderer.invoke("search:updateSources", sources),
  rebuildSearchIndex: (): Promise<SearchIndexState> => ipcRenderer.invoke("search:rebuildIndex"),
  getSearchHotkey: (): Promise<string> => ipcRenderer.invoke("search:getHotkey"),
  setSearchHotkey: (accelerator: string): Promise<{ ok: boolean; hotkey: string }> =>
    ipcRenderer.invoke("search:setHotkey", accelerator),
  showSearch: (): Promise<boolean> => ipcRenderer.invoke("search:show"),
  hideSearch: (): Promise<boolean> => ipcRenderer.invoke("search:hide"),
  revealPath: (path: string) => ipcRenderer.invoke("shell:revealPath", path),
  windowControl: (action: "minimize" | "maximize" | "close") =>
    ipcRenderer.invoke("app:windowControl", action),
  onCommandOpen: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("command:open", listener);
    return () => {
      ipcRenderer.removeListener("command:open", listener);
    };
  },
  onCommandHide: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("command:hide", listener);
    return () => {
      ipcRenderer.removeListener("command:hide", listener);
    };
  },
  onSearchStale: (callback: (state: SearchIndexState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: SearchIndexState) => callback(state);
    ipcRenderer.on("search:stale", listener);
    return () => {
      ipcRenderer.removeListener("search:stale", listener);
    };
  }
};

contextBridge.exposeInMainWorld("fileManager", api);
