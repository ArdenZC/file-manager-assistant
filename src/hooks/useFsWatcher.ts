import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import { tauriApi } from "../api/tauriApi";
import type { Rule } from "../types/domain";
import { readableError } from "../utils/viewHelpers";
import {
  takeWatcherQueueBatch,
  WATCHER_QUEUE_BATCH_LIMIT,
  watcherQueueSnapshotFromEvent,
  type FsWatchEvent
} from "./fsWatcherQueue";

interface FsWatcherOptions {
  onRefreshData: () => Promise<void>;
  onError?: (message: string) => void;
  rules?: Rule[];
  enabled?: boolean;
}

const WATCHER_FLUSH_DELAY_MS = 500;
const WATCHER_CLASSIFY_LIMIT = 500;
const EMPTY_RULES: Rule[] = [];

export function useFsWatcher({
  onRefreshData,
  onError,
  rules = EMPTY_RULES,
  enabled = true
}: FsWatcherOptions) {
  const rulesRef = useRef(rules);

  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);

  useEffect(() => {
    if (!enabled) return;

    let disposed = false;
    let queue = Promise.resolve();
    let flushTimer: ReturnType<typeof setTimeout> | undefined;
    let staleQueue = new Set<string>();
    let upsertQueue = new Set<string>();

    const flushQueues = () => {
      queue = queue
        .then(async () => {
          const snapshot = takeWatcherQueueBatch(staleQueue, upsertQueue, WATCHER_QUEUE_BATCH_LIMIT);
          if (!snapshot.stale.length && !snapshot.upsert.length) return;

          let changed = false;
          if (snapshot.stale.length > 0) {
            try {
              changed = (await tauriApi.markFilesStaleByPaths(snapshot.stale)) > 0 || changed;
            } catch (error) {
              if (!disposed) {
                onError?.(readableError(error));
              }
            }
          }
          let upserted = 0;
          if (snapshot.upsert.length > 0) {
            try {
              upserted = await tauriApi.upsertFilesByPaths(snapshot.upsert);
              changed = upserted > 0 || changed;
            } catch (error) {
              if (!disposed) {
                onError?.(readableError(error));
              }
            }
          }
          if (upserted > 0 && snapshot.upsert.length > 0) {
            try {
              const summary = await tauriApi.executeRulesForPaths(
                snapshot.upsert.slice(0, WATCHER_CLASSIFY_LIMIT),
                rulesRef.current
              );
              changed = summary.updated > 0 || changed;
            } catch (error) {
              if (!disposed) {
                onError?.(readableError(error));
              }
            }
          }
          if (changed && !disposed) {
            await onRefreshData();
          }
        })
        .catch((error) => {
          if (!disposed) {
            onError?.(readableError(error));
          }
        })
        .finally(() => {
          if (!disposed && (staleQueue.size > 0 || upsertQueue.size > 0)) {
            scheduleFlush();
          }
        });
    };

    const scheduleFlush = () => {
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
      }
      flushTimer = setTimeout(() => {
        flushTimer = undefined;
        flushQueues();
      }, WATCHER_FLUSH_DELAY_MS);
    };

    const unlistenPromise = listen<FsWatchEvent>("fs-event", (event) => {
      const payload = event.payload;
      if (!payload) return;

      const snapshot = watcherQueueSnapshotFromEvent(payload);
      if (!snapshot.stale.length && !snapshot.upsert.length) return;

      for (const path of snapshot.stale) {
        staleQueue.add(path);
      }
      for (const path of snapshot.upsert) {
        upsertQueue.add(path);
        staleQueue.delete(path);
      }
      scheduleFlush();
    });

    return () => {
      disposed = true;
      if (flushTimer !== undefined) {
        clearTimeout(flushTimer);
      }
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [enabled, onError, onRefreshData]);
}
