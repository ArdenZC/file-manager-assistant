import { create } from "zustand";
import { open } from "@tauri-apps/plugin-dialog";
import type { UnlistenFn } from "@tauri-apps/api/event";
import {
  tauriApi,
  type ScanBatchPayload,
  type ScanProgressPayload,
  type ScanSummary,
  type ScannedEntry
} from "../api/tauriApi";
import { enabledScanRootPaths } from "../hooks/useAppSettings";
import { makeTranslator } from "../i18n";
import type { ScanRootSetting } from "../types/domain";
import { readableError } from "../utils/viewHelpers";
import { useAppStore } from "./useAppStore";
import { useFileLibraryStore } from "./useFileLibraryStore";

export type ScanStatus = "idle" | "scanning" | "completed" | "error";

export interface ScanStateData {
  status: ScanStatus;
  progress: ScanProgressPayload | null;
  entries: ScannedEntry[];
  error: string | null;
}

const initialScanState: ScanStateData = {
  status: "idle",
  progress: null,
  entries: [],
  error: null
};

export interface ScanManagerStore {
  selectedFolders: string[];
  defaultScanRoots: ScanRootSetting[];
  isScanning: boolean;
  scanState: ScanStateData;
  listenersRegistered: boolean;
  registrationPromise: Promise<void> | null;
  unlisteners: UnlistenFn[];
  initializeScanListeners: () => Promise<void>;
  setDefaultScanRoots: (roots: ScanRootSetting[]) => void;
  reset: () => void;
  scanPath: (path: string) => Promise<void>;
  scanPaths: (paths: string[]) => Promise<void>;
  handleScan: () => Promise<void>;
  handleChooseFolders: () => Promise<void>;
  cancelScan: () => Promise<void>;
}

function currentT() {
  return makeTranslator(useAppStore.getState().language);
}

async function askForScanPath() {
  const t = currentT();
  const selectedPath = await open({
    directory: true,
    multiple: false,
    title: t("folderPickerTitle"),
    defaultPath: useScanManagerStore.getState().selectedFolders[0]
  });

  if (Array.isArray(selectedPath)) return selectedPath[0]?.trim() ?? "";
  return selectedPath?.trim() ?? "";
}

export const useScanManagerStore = create<ScanManagerStore>((set, get) => ({
  selectedFolders: [],
  defaultScanRoots: [],
  isScanning: false,
  scanState: initialScanState,
  listenersRegistered: false,
  registrationPromise: null,
  unlisteners: [],
  initializeScanListeners: () => {
    if (get().listenersRegistered) return Promise.resolve();
    const registrationPromise = get().registrationPromise;
    if (registrationPromise) return registrationPromise;

    const promise = (async () => {
      try {
        const unlisteners = await Promise.all([
          tauriApi.onScanProgress((progress) => {
            set((state) => ({
              scanState: {
                ...state.scanState,
                status: "scanning",
                progress,
                error: null
              }
            }));
          }),
          tauriApi.onScanBatch((batch: ScanBatchPayload) => {
            set((state) => ({
              scanState: {
                ...state.scanState,
                status: "scanning",
                progress: batch.progress,
                error: null
              }
            }));
          }),
          tauriApi.onScanComplete((summary: ScanSummary) => {
            set((state) => ({
              scanState: {
                ...state.scanState,
                status: "completed",
                progress: summary,
                error: null
              }
            }));
          }),
          tauriApi.onScanError((payload) => {
            set((state) => ({
              scanState: {
                ...state.scanState,
                status: state.scanState.status === "idle" ? "scanning" : state.scanState.status,
                progress: state.scanState.progress
                  ? {
                      ...state.scanState.progress,
                      errors: state.scanState.progress.errors + 1
                    }
                  : {
                      root: payload.root,
                      scanned: 0,
                      files: 0,
                      directories: 0,
                      skipped: 0,
                      errors: 1,
                      elapsedMs: 0
                    },
                error: null
              }
            }));
          })
        ]);
        set({ listenersRegistered: true, registrationPromise: null, unlisteners });
      } catch (error) {
        set((state) => ({
          registrationPromise: null,
          scanState: {
            ...state.scanState,
            status: "error",
            error: readableError(error)
          }
        }));
        useAppStore.getState().showError(readableError(error));
      }
    })();
    set({ registrationPromise: promise });
    return promise;
  },
  setDefaultScanRoots: (roots) => set({ defaultScanRoots: roots }),
  reset: () => set({ scanState: initialScanState }),
  scanPath: async (path) => {
    await get().scanPaths([path]);
  },
  scanPaths: async (paths) => {
    const t = currentT();
    const scanRoots = paths.map((path) => path.trim()).filter(Boolean);
    if (!scanRoots.length) {
      useAppStore.getState().showError(t("noFolderSelected"));
      return;
    }

    set({
      selectedFolders: scanRoots,
      isScanning: true,
      scanState: initialScanState
    });

    try {
      let totalFiles = 0;
      for (const path of scanRoots) {
        const summary = await tauriApi.startScan(path, false);
        totalFiles += summary.files;
      }
      useFileLibraryStore.getState().setCurrentScanScope(scanRoots);
      await useFileLibraryStore.getState().refresh(useAppStore.getState().searchQuery);
      useAppStore.getState().showSuccess(`${t("success")}: ${totalFiles.toLocaleString()} ${t("files")}`);
    } catch (error) {
      const message = readableError(error);
      set((state) => ({
        scanState: {
          ...state.scanState,
          status: "error",
          error: message
        }
      }));
      useAppStore.getState().showError(message);
    } finally {
      set({ isScanning: false });
    }
  },
  handleScan: async () => {
    try {
      const { defaultScanRoots, scanPaths } = get();
      const defaultPaths = enabledScanRootPaths(defaultScanRoots);
      const paths = defaultPaths.length ? defaultPaths : [await askForScanPath()].filter(Boolean);
      await scanPaths(paths);
    } catch (error) {
      useAppStore.getState().showError(readableError(error));
    }
  },
  handleChooseFolders: async () => {
    try {
      const path = await askForScanPath();
      if (path) await get().scanPath(path);
    } catch (error) {
      useAppStore.getState().showError(readableError(error));
    }
  },
  cancelScan: async () => {
    await tauriApi.cancelScan();
    set({ isScanning: false });
  }
}));
