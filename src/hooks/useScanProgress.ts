import { useCallback, useEffect, useRef, useState } from "react";
import { type UnlistenFn } from "@tauri-apps/api/event";
import {
  tauriApi,
  type ScanBatchPayload,
  type ScanProgressPayload,
  type ScanSummary,
  type ScannedEntry
} from "../api/tauriApi";

export type ScanStatus = "idle" | "scanning" | "completed" | "error";

export interface UseScanProgressState {
  status: ScanStatus;
  progress: ScanProgressPayload | null;
  entries: ScannedEntry[];
  error: string | null;
}

export interface UseScanProgressOptions {
  keepEntries?: boolean;
  onBatch?: (batch: ScanBatchPayload) => void;
  onComplete?: (summary: ScanSummary) => void;
  onError?: (message: string) => void;
}

const initialState: UseScanProgressState = {
  status: "idle",
  progress: null,
  entries: [],
  error: null
};

export function useScanProgress(options: UseScanProgressOptions = {}) {
  const optionsRef = useRef(options);
  const [state, setState] = useState<UseScanProgressState>(initialState);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    let disposed = false;
    const unlisteners: UnlistenFn[] = [];

    async function registerListeners() {
      const [unlistenProgress, unlistenBatch, unlistenComplete, unlistenError] = await Promise.all([
        tauriApi.onScanProgress((progress) => {
          if (disposed) return;
          setState((current) => ({
            ...current,
            status: "scanning",
            progress,
            error: null
          }));
        }),
        tauriApi.onScanBatch((batch) => {
          if (disposed) return;
          optionsRef.current.onBatch?.(batch);
          setState((current) => ({
            ...current,
            status: "scanning",
            progress: batch.progress,
            entries: optionsRef.current.keepEntries
              ? current.entries.concat(batch.entries)
              : current.entries,
            error: null
          }));
        }),
        tauriApi.onScanComplete((summary) => {
          if (disposed) return;
          optionsRef.current.onComplete?.(summary);
          setState((current) => ({
            ...current,
            status: "completed",
            progress: summary,
            error: null
          }));
        }),
        tauriApi.onScanError((payload) => {
          if (disposed) return;
          optionsRef.current.onError?.(payload.message);
          setState((current) => ({
            ...current,
            status: "error",
            error: payload.message
          }));
        })
      ]);

      unlisteners.push(unlistenProgress, unlistenBatch, unlistenComplete, unlistenError);
    }

    registerListeners().catch((error) => {
      if (disposed) return;
      setState((current) => ({
        ...current,
        status: "error",
        error: error instanceof Error ? error.message : String(error)
      }));
    });

    return () => {
      disposed = true;
      for (const unlisten of unlisteners) {
        unlisten();
      }
    };
  }, []);

  const startScan = useCallback(async (path: string) => {
    setState({
      status: "scanning",
      progress: null,
      entries: [],
      error: null
    });
    return tauriApi.startScan(path);
  }, []);

  const reset = useCallback(() => {
    setState(initialState);
  }, []);

  return {
    ...state,
    startScan,
    reset
  };
}
