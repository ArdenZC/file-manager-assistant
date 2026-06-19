import { useCallback, useRef, useState } from "react";
import { tauriApi } from "../api/tauriApi";
import type { Translator } from "../types/ui";
import { readableError } from "../utils/viewHelpers";
import { useScanProgress } from "./useScanProgress";

interface UseScanManagerOptions {
  t: Translator;
  loadStats: () => Promise<void>;
  loadFirstPage: () => Promise<void>;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
  clearToast: () => void;
}

export function useScanManager({
  t,
  loadStats,
  loadFirstPage,
  showSuccess,
  showError,
  clearToast
}: UseScanManagerOptions) {
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [isScanning, setIsScanning] = useState(false);
  const lastScanStatsRefreshRef = useRef(0);

  const refreshStatsDuringScan = useCallback(() => {
    const now = Date.now();
    if (now - lastScanStatsRefreshRef.current < 1000) return;
    lastScanStatsRefreshRef.current = now;
    void loadStats();
  }, [loadStats]);

  const scanState = useScanProgress({
    onBatch: refreshStatsDuringScan,
    onComplete: () => {
      lastScanStatsRefreshRef.current = 0;
      void Promise.all([loadStats(), loadFirstPage()]);
    }
  });

  const askForScanPath = useCallback(
    () => window.prompt(t("folderPickerTitle"), selectedFolders[0] ?? "")?.trim() ?? "",
    [selectedFolders, t]
  );

  const scanPath = useCallback(
    async (path: string) => {
      if (!path) {
        showError(t("noFolderSelected"));
        return;
      }
      setSelectedFolders([path]);
      setIsScanning(true);
      clearToast();
      scanState.reset();
      try {
        const summary = await scanState.startScan(path);
        await Promise.all([loadStats(), loadFirstPage()]);
        showSuccess(`${t("success")}: ${summary.files.toLocaleString()} ${t("files")}`);
      } catch (error) {
        showError(readableError(error));
      } finally {
        setIsScanning(false);
      }
    },
    [clearToast, loadFirstPage, loadStats, scanState, showError, showSuccess, t]
  );

  const handleScan = useCallback(async () => {
    const paths = selectedFolders.length > 0 ? selectedFolders : [askForScanPath()].filter(Boolean);
    for (const path of paths) {
      if (path) await scanPath(path);
    }
  }, [askForScanPath, scanPath, selectedFolders]);

  const handleChooseFolders = useCallback(async () => {
    await scanPath(askForScanPath());
  }, [askForScanPath, scanPath]);

  const cancelScan = useCallback(async () => {
    await tauriApi.cancelScan();
    setIsScanning(false);
  }, []);

  return {
    selectedFolders,
    isScanning,
    scanState,
    handleScan,
    handleChooseFolders,
    cancelScan
  };
}
