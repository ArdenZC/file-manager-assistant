import { useCallback, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { tauriApi } from "../api/tauriApi";
import type { Translator } from "../types/ui";
import { readableError } from "../utils/viewHelpers";
import { useScanProgress } from "./useScanProgress";

export interface ScanManagerOptions {
  t: Translator;
  loadStats: () => Promise<void>;
  onRefreshData: () => Promise<void>;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

export function useScanManager({
  t,
  loadStats,
  onRefreshData,
  onError,
  onSuccess
}: ScanManagerOptions) {
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
      void onRefreshData();
    }
  });
  const { startScan, reset, ...scanStateData } = scanState;

  const askForScanPath = useCallback(
    async () => {
      const selectedPath = await open({
        directory: true,
        multiple: false,
        title: t("folderPickerTitle"),
        defaultPath: selectedFolders[0]
      });

      if (Array.isArray(selectedPath)) return selectedPath[0]?.trim() ?? "";
      return selectedPath?.trim() ?? "";
    },
    [selectedFolders, t]
  );

  const scanPath = useCallback(
    async (path: string) => {
      if (!path) {
        onError(t("noFolderSelected"));
        return;
      }
      setSelectedFolders([path]);
      setIsScanning(true);
      reset();
      try {
        const summary = await startScan(path);
        await onRefreshData();
        onSuccess(`${t("success")}: ${summary.files.toLocaleString()} ${t("files")}`);
      } catch (error) {
        onError(readableError(error));
      } finally {
        setIsScanning(false);
      }
    },
    [onError, onRefreshData, onSuccess, reset, startScan, t]
  );

  const handleScan = useCallback(async () => {
    try {
      const requestedPath = selectedFolders.length > 0 ? "" : await askForScanPath();
      const paths = selectedFolders.length > 0 ? selectedFolders : [requestedPath].filter(Boolean);
      for (const path of paths) {
        if (path) await scanPath(path);
      }
    } catch (error) {
      onError(readableError(error));
    }
  }, [askForScanPath, onError, scanPath, selectedFolders]);

  const handleChooseFolders = useCallback(async () => {
    try {
      const path = await askForScanPath();
      if (path) await scanPath(path);
    } catch (error) {
      onError(readableError(error));
    }
  }, [askForScanPath, onError, scanPath]);

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
