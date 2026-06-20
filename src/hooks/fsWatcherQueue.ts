export interface FsWatchEvent {
  eventType?: string;
  event_type?: string;
  paths?: string[];
  path?: string;
  deleted?: boolean;
  removed?: boolean;
  isDeleted?: boolean;
}

export type FsWatchEventAction = "stale" | "upsert" | "ignore";

export interface WatcherQueueSnapshot {
  stale: string[];
  upsert: string[];
}

export function classifyFsWatchEvent(payload: FsWatchEvent): FsWatchEventAction {
  if (isRemoveEvent(payload)) return "stale";
  if (isUpsertEvent(payload)) return "upsert";
  return eventPaths(payload).length > 0 ? "upsert" : "ignore";
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
    eventType.includes("modify") ||
    eventType.includes("rename") ||
    eventType.includes("change")
  );
}

function eventTypeText(payload: FsWatchEvent): string {
  return String(payload.eventType ?? payload.event_type ?? "").toLowerCase();
}
