export interface FsWatchEvent {
  eventType?: string;
  event_type?: string;
  paths?: string[];
  path?: string;
  stalePaths?: string[];
  stale_paths?: string[];
  upsertPaths?: string[];
  upsert_paths?: string[];
  deleted?: boolean;
  removed?: boolean;
  isDeleted?: boolean;
}

export type FsWatchEventAction = "stale" | "upsert" | "ignore";

export interface WatcherQueueSnapshot {
  stale: string[];
  upsert: string[];
}

export const WATCHER_QUEUE_BATCH_LIMIT = 500;

export function classifyFsWatchEvent(payload: FsWatchEvent): FsWatchEventAction {
  if (isRemoveEvent(payload)) return "stale";
  if (isUpsertEvent(payload)) return "upsert";
  return "ignore";
}

export function eventPaths(payload: FsWatchEvent): string[] {
  const paths = Array.isArray(payload.paths) ? payload.paths : payload.path ? [payload.path] : [];
  return Array.from(new Set(paths.map((path) => path.trim()).filter(Boolean)));
}

export function mergeWatcherQueues(
  staleQueue: Set<string>,
  upsertQueue: Set<string>
): WatcherQueueSnapshot {
  const upsert = Array.from(upsertQueue);
  const upsertSet = new Set(upsert);
  const stale = Array.from(staleQueue).filter((path) => !upsertSet.has(path));

  return { stale, upsert };
}

export function takeWatcherQueueBatch(
  staleQueue: Set<string>,
  upsertQueue: Set<string>,
  limit = WATCHER_QUEUE_BATCH_LIMIT
): WatcherQueueSnapshot {
  const boundedLimit = Math.max(1, Math.floor(limit));
  const stale: string[] = [];
  const upsert: string[] = [];

  for (const path of upsertQueue) {
    staleQueue.delete(path);
  }

  const initialUpsertLimit = Math.ceil(boundedLimit / 2);
  takeFromQueue(upsertQueue, upsert, initialUpsertLimit);
  takeFromQueue(staleQueue, stale, boundedLimit - upsert.length);
  takeFromQueue(upsertQueue, upsert, boundedLimit - stale.length - upsert.length);

  return { stale, upsert };
}

export function watcherQueueSnapshotFromEvent(payload: FsWatchEvent): WatcherQueueSnapshot {
  const explicitStale = normalizePathList(payload.stalePaths ?? payload.stale_paths);
  const explicitUpsert = normalizePathList(payload.upsertPaths ?? payload.upsert_paths);

  if (explicitStale.length > 0 || explicitUpsert.length > 0) {
    return mergeWatcherQueues(new Set(explicitStale), new Set(explicitUpsert));
  }

  const paths = eventPaths(payload);
  const action = classifyFsWatchEvent(payload);
  if (action === "stale") {
    return { stale: paths, upsert: [] };
  }
  if (action === "upsert") {
    return { stale: [], upsert: paths };
  }
  return { stale: [], upsert: [] };
}

function isRemoveEvent(payload: FsWatchEvent): boolean {
  const eventType = eventTypeText(payload);
  return (
    eventType.includes("remove") ||
    eventType.includes("delete") ||
    payload.deleted === true ||
    payload.removed === true ||
    payload.isDeleted === true
  );
}

function isUpsertEvent(payload: FsWatchEvent): boolean {
  const eventType = eventTypeText(payload);
  return (
    eventType.includes("create") ||
    eventType.includes("modif") ||
    eventType.includes("rename") ||
    eventType.includes("change")
  );
}

function eventTypeText(payload: FsWatchEvent): string {
  return String(payload.eventType ?? payload.event_type ?? "").toLowerCase();
}

function normalizePathList(paths: unknown): string[] {
  if (!Array.isArray(paths)) return [];
  return Array.from(
    new Set(paths.filter((path): path is string => typeof path === "string").map((path) => path.trim()).filter(Boolean))
  );
}

function takeFromQueue(queue: Set<string>, target: string[], count: number) {
  if (count <= 0) return;
  let taken = 0;
  for (const path of queue) {
    target.push(path);
    queue.delete(path);
    taken += 1;
    if (taken >= count) return;
  }
}
