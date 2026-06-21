import { create } from "zustand";
import { tauriApi } from "../api/tauriApi";
import type { DashboardStats, FileQueryResult } from "../types/domain";
import { readableError } from "../utils/viewHelpers";
import { useAppStore } from "./useAppStore";

export const LIBRARY_PAGE_SIZE = 50;

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
  stats: DashboardStats;
  libraryPage: FileQueryResult;
  selectedFileId: string;
  firstPageRequestId: number;
  setLibraryPage: (page: FileQueryResult | ((current: FileQueryResult) => FileQueryResult)) => void;
  setSelectedFileId: (id: string) => void;
  loadStats: () => Promise<void>;
  loadFirstPage: (query?: string) => Promise<void>;
  refresh: (query?: string) => Promise<void>;
}

export const useFileLibraryStore = create<FileLibraryStore>((set, get) => ({
  stats: emptyStats,
  libraryPage: emptyPage,
  selectedFileId: "",
  firstPageRequestId: 0,
  setLibraryPage: (page) =>
    set((state) => ({
      libraryPage: typeof page === "function" ? page(state.libraryPage) : page
    })),
  setSelectedFileId: (selectedFileId) => set({ selectedFileId }),
  loadStats: async () => {
    try {
      set({ stats: await tauriApi.getStatsSummary() });
    } catch (error) {
      set({ stats: emptyStats });
      useAppStore.getState().showError(readableError(error));
    }
  },
  loadFirstPage: async (query) => {
    const requestId = get().firstPageRequestId + 1;
    set({ firstPageRequestId: requestId });
    try {
      const page = await tauriApi.getPagedFiles(LIBRARY_PAGE_SIZE, 0, query || undefined);
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
  refresh: async (query) => {
    await Promise.all([get().loadStats(), get().loadFirstPage(query)]);
  }
}));

export function getSelectedFile() {
  const { libraryPage, selectedFileId } = useFileLibraryStore.getState();
  return libraryPage.files.find((file) => file.id === selectedFileId) ?? libraryPage.files[0];
}
