import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { tauriApi } from "../api/tauriApi";
import { readableError } from "../utils/viewHelpers";

interface FsWatchEvent {
  eventType?: string;
  event_type?: string;
  paths?: string[];
  path?: string;
  deleted?: boolean;
  removed?: boolean;
  isDeleted?: boolean;
}

interface FsWatcherOptions {
  onRefreshData: () => Promise<void>;
  onError?: (message: string) => void;
}

function isRemoveEvent(payload: FsWatchEvent): boolean {
  const eventType = String(payload.eventType ?? payload.event_type ?? "").toLowerCase();
  return (
    eventType.includes("remove") ||
    eventType.includes("delete") ||
    payload.deleted === true ||
    payload.removed === true ||
    payload.isDeleted === true
  );
}

function eventPaths(payload: FsWatchEvent): string[] {
  const paths = Array.isArray(payload.paths) ? payload.paths : payload.path ? [payload.path] : [];
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}

export function useFsWatcher({ onRefreshData, onError }: FsWatcherOptions) {
  useEffect(() => {
    let disposed = false;
    let queue = Promise.resolve();
    const unlistenPromise = listen<FsWatchEvent>("fs-event", (event) => {
      const payload = event.payload;
      if (!payload || !isRemoveEvent(payload)) return;

      const paths = eventPaths(payload);
      if (!paths.length) return;

      queue = queue
        .then(async () => {
          const affected = await tauriApi.removeFilesByPaths(paths);
          if (affected > 0 && !disposed) {
            await onRefreshData();
          }
        })
        .catch((error) => {
          if (!disposed) {
            onError?.(readableError(error));
          }
        });
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [onError, onRefreshData]);
}
