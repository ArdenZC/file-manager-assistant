import { create } from "zustand";
import { tauriApi } from "../api/tauriApi";
import type {
  DashboardStats,
  FileLibraryFilters,
  FileQueryResult,
  FileRecord,
  LibraryFilter,
  LibraryScope
} from "../types/domain";
import { readableError } from "../utils/viewHelpers";
import { useAppStore } from "./useAppStore";

export const LIBRARY_PAGE_SIZE = 50;
export const ORGANIZE_QUEUE_PAGE_SIZE = 500;
export const ORGANIZE_QUEUE_MAX_FILES = 3000;
export const LIBRARY_SCOPE_STORAGE_KEY = "zc-library-scope";
export const defaultLibraryScope: LibraryScope = { kind: "current_scan", roots: [] };

function browserLocalStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isLibraryScope(value: unknown): value is LibraryScope {
  if (!value || typeof value !== "object" || !("kind" in value)) return false;
  const scope = value as Partial<LibraryScope>;
  if (scope.kind === "all") return true;
  if (scope.kind === "roots") return isStringArray(scope.roots);
  if (scope.kind === "current_scan") {
    return isStringArray(scope.roots)
      && (!("scanSessionId" in scope) || typeof scope.scanSessionId === "string" || scope.scanSessionId === undefined);
  }
  return false;
}

export function readPersistedLibraryScope(): LibraryScope {
  const raw = browserLocalStorage()?.getItem(LIBRARY_SCOPE_STORAGE_KEY);
  if (!raw) return defaultLibraryScope;

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isLibraryScope(parsed) ? parsed : defaultLibraryScope;
  } catch {
    return defaultLibraryScope;
  }
}

function persistLibraryScope(scope: LibraryScope) {
  browserLocalStorage()?.setItem(LIBRARY_SCOPE_STORAGE_KEY, JSON.stringify(scope));
}

function filtersForLibraryFilter(libraryFilter: LibraryFilter): FileLibraryFilters | undefined {
  return libraryFilter === "all" ? undefined : { libraryFilter };
}

export const emptyStats: DashboardStats = {
  totalFiles: 0,
  totalSize: 0,
  diskTotalSize: 0,
  diskFreeSize: 0,
  diskUsageRatio: 0,
  duplicateFiles: 0,
  largeFiles: 0,
  sensitiveFiles: 0,
  needsConfirmation: 0,
  byType: {},
  byLifecycle: {},
  lastScannedAt: null
};

export const emptyPage: FileQueryResult = {
  files: [],
  total: 0,
  limit: LIBRARY_PAGE_SIZE,
  offset: 0
};

export interface FileLibraryStore {
  scope: LibraryScope;
  stats: DashboardStats;
  libraryPage: FileQueryResult;
  organizeQueue: FileRecord[];
  organizeQueueTotal: number;
  organizeQueueTruncated: boolean;
  isLoadingOrganizeQueue: boolean;
  libraryFilter: LibraryFilter;
  selectedFileId: string;
  firstPageRequestId: number;
  setScope: (scope: LibraryScope) => void;
  setCurrentScanScope: (roots: string[], scanSessionId?: string) => void;
  setLibraryFilter: (libraryFilter: LibraryFilter) => void;
  setLibraryPage: (page: FileQueryResult | ((current: FileQueryResult) => FileQueryResult)) => void;
  setSelectedFileId: (id: string) => void;
  loadStats: (scope?: LibraryScope) => Promise<void>;
  loadFirstPage: (query?: string, scope?: LibraryScope, libraryFilter?: LibraryFilter) => Promise<void>;
  loadOrganizeQueue: (scope?: LibraryScope) => Promise<void>;
  refresh: (query?: string) => Promise<void>;
}

export const useFileLibraryStore = create<FileLibraryStore>((set, get) => ({
  scope: readPersistedLibraryScope(),
  stats: emptyStats,
  libraryPage: emptyPage,
  organizeQueue: [],
  organizeQueueTotal: 0,
  organizeQueueTruncated: false,
  isLoadingOrganizeQueue: false,
  libraryFilter: "all",
  selectedFileId: "",
  firstPageRequestId: 0,
  setScope: (scope) => {
    persistLibraryScope(scope);
    set({ scope });
  },
  setCurrentScanScope: (roots, scanSessionId) => {
    const scope: LibraryScope = {
      kind: "current_scan",
      roots,
      ...(scanSessionId ? { scanSessionId } : {})
    };
    persistLibraryScope(scope);
    set({ scope });
  },
  setLibraryFilter: (libraryFilter) => set({ libraryFilter }),
  setLibraryPage: (page) =>
    set((state) => ({
      libraryPage: typeof page === "function" ? page(state.libraryPage) : page
    })),
  setSelectedFileId: (selectedFileId) => set({ selectedFileId }),
  loadStats: async (scope = get().scope) => {
    try {
      set({ stats: await tauriApi.getStatsSummary(scope) });
    } catch (error) {
      set({ stats: emptyStats });
      useAppStore.getState().showError(readableError(error));
    }
  },
  loadFirstPage: async (query, scope = get().scope, libraryFilter = get().libraryFilter) => {
    const requestId = get().firstPageRequestId + 1;
    set({ firstPageRequestId: requestId });
    try {
      const page = await tauriApi.getPagedFiles(
        LIBRARY_PAGE_SIZE,
        0,
        query || undefined,
        scope,
        filtersForLibraryFilter(libraryFilter)
      );
      if (requestId !== get().firstPageRequestId) return;
      set((state) => ({
        libraryPage: page,
        selectedFileId: page.files.some((file) => file.id === state.selectedFileId)
          ? state.selectedFileId
          : page.files[0]?.id || ""
      }));
    } catch (error) {
      if (requestId !== get().firstPageRequestId) return;
      set({
        libraryPage: emptyPage,
        selectedFileId: ""
      });
      useAppStore.getState().showError(readableError(error));
    }
  },
  loadOrganizeQueue: async (scope = get().scope) => {
    set({ isLoadingOrganizeQueue: true });
    try {
      const files: FileRecord[] = [];
      let total = 0;
      let offset = 0;

      while (files.length < ORGANIZE_QUEUE_MAX_FILES) {
        const page = await tauriApi.getPagedFiles(ORGANIZE_QUEUE_PAGE_SIZE, offset, undefined, scope);
        total = page.total;
        files.push(...page.files.slice(0, ORGANIZE_QUEUE_MAX_FILES - files.length));

        if (!page.files.length || files.length >= total) break;
        offset += ORGANIZE_QUEUE_PAGE_SIZE;
      }

      set({
        organizeQueue: files,
        organizeQueueTotal: total,
        organizeQueueTruncated: total > ORGANIZE_QUEUE_MAX_FILES,
        isLoadingOrganizeQueue: false
      });
    } catch (error) {
      set({
        organizeQueue: [],
        organizeQueueTotal: 0,
        organizeQueueTruncated: false,
        isLoadingOrganizeQueue: false
      });
      useAppStore.getState().showError(readableError(error));
    }
  },
  refresh: async (query) => {
    const scope = get().scope;
    await Promise.all([get().loadStats(scope), get().loadFirstPage(query, scope, get().libraryFilter)]);
  }
}));

export function getSelectedFile() {
  const { libraryPage, selectedFileId } = useFileLibraryStore.getState();
  return libraryPage.files.find((file) => file.id === selectedFileId) ?? libraryPage.files[0];
}
