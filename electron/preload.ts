import { contextBridge, ipcRenderer } from "electron";
import type {
  AppSnapshot,
  ExecuteOperationRequest,
  FileQuery,
  Rule,
  ScanResult
} from "../src/types/domain.js";

const api = {
  getSnapshot: (): Promise<AppSnapshot> => ipcRenderer.invoke("app:getSnapshot"),
  scanDefaults: (): Promise<ScanResult> => ipcRenderer.invoke("scan:defaults"),
  queryFiles: (query: FileQuery) => ipcRenderer.invoke("files:query", query),
  saveRule: (rule: Rule) => ipcRenderer.invoke("rules:save", rule),
  deleteRule: (id: string) => ipcRenderer.invoke("rules:delete", id),
  reapplyRules: () => ipcRenderer.invoke("rules:reapply"),
  executeOperations: (request: ExecuteOperationRequest) =>
    ipcRenderer.invoke("operations:execute", request),
  revealPath: (path: string) => ipcRenderer.invoke("shell:revealPath", path)
};

contextBridge.exposeInMainWorld("fileManager", api);

export type FileManagerApi = typeof api;

