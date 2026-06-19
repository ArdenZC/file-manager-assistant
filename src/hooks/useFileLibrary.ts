import { useCallback, useRef, useState } from "react";
import { tauriApi } from "../api/tauriApi";
import type { DashboardStats, FileQueryResult, FileRecord } from "../types/domain";
import { readableError } from "../utils/viewHelpers";

const PAGE_SIZE = 50;

const emptyStats: DashboardStats = {
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

const emptyPage: FileQueryResult = {
  files: [],
  total: 0,
  limit: PAGE_SIZE,
  offset: 0
};

export interface FileLibraryOptions {
  debouncedSearchQuery: string;
  onError: (message: string) => void;
}

export function useFileLibrary({ debouncedSearchQuery, onError }: FileLibraryOptions) {
  const [stats, setStats] = useState<DashboardStats>(emptyStats);
  const [libraryPage, setLibraryPage] = useState<FileQueryResult>(emptyPage);
  const [selectedFileId, setSelectedFileId] = useState("");
  const firstPageRequestIdRef = useRef(0);

  const loadStats = useCallback(async () => {
    try {
      setStats(await tauriApi.getStatsSummary());
    } catch (error) {
      setStats(emptyStats);
      onError(readableError(error));
    }
  }, [onError]);

  const loadFirstPage = useCallback(async () => {
    const requestId = ++firstPageRequestIdRef.current;
    try {
      const page = await tauriApi.getPagedFiles(PAGE_SIZE, 0, debouncedSearchQuery || undefined);
      if (requestId !== firstPageRequestIdRef.current) return;
      setLibraryPage(page);
      setSelectedFileId((current) => (page.files.some((file) => file.id === current) ? current : page.files[0]?.id || ""));
    } catch (error) {
      if (requestId !== firstPageRequestIdRef.current) return;
      setLibraryPage(emptyPage);
      setSelectedFileId("");
      onError(readableError(error));
    }
  }, [debouncedSearchQuery, onError]);

  const refresh = useCallback(async () => {
    await Promise.all([loadStats(), loadFirstPage()]);
  }, [loadFirstPage, loadStats]);

  const files: FileRecord[] = libraryPage.files;
  const selectedFile = files.find((file) => file.id === selectedFileId) ?? files[0];

  return {
    stats,
    libraryPage,
    setLibraryPage,
    files,
    selectedFileId,
    selectedFile,
    setSelectedFileId,
    loadStats,
    loadFirstPage,
    refresh
  };
}
