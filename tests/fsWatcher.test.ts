import { describe, expect, it } from "vitest";
import {
  classifyFsWatchEvent,
  watcherQueueSnapshotFromEvent,
  mergeWatcherQueues,
  takeWatcherQueueBatch,
  type FsWatchEvent
} from "../src/hooks/fsWatcherQueue";

describe("fs watcher event routing", () => {
  it("routes remove events to the stale queue", () => {
    expect(classifyFsWatchEvent({ eventType: "remove", paths: ["a.txt"] })).toBe("stale");
    expect(classifyFsWatchEvent({ deleted: true, path: "a.txt" })).toBe("stale");
  });

  it("routes modified events to the upsert queue", () => {
    expect(classifyFsWatchEvent({ eventType: "modified", paths: ["a.txt"] })).toBe("upsert");
    expect(classifyFsWatchEvent({ event_type: "changed", path: "a.txt" })).toBe("upsert");
  });

  it("ignores read-only and unknown events", () => {
    expect(classifyFsWatchEvent({ eventType: "accessed", paths: ["a.txt"] })).toBe("ignore");
    expect(classifyFsWatchEvent({ eventType: "other", paths: ["a.txt"] })).toBe("ignore");
  });

  it("lets upsert win when the same path appears in both queues", () => {
    const merged = mergeWatcherQueues(new Set(["a.txt", "stale.txt"]), new Set(["a.txt"]));

    expect(merged.stale).toEqual(["stale.txt"]);
    expect(merged.upsert).toEqual(["a.txt"]);
  });

  it("routes rename old paths stale and new paths upsert", () => {
    const snapshot = watcherQueueSnapshotFromEvent({
      eventType: "renamed",
      paths: ["old.txt", "new.txt"],
      stalePaths: ["old.txt"],
      upsertPaths: ["new.txt"]
    });

    expect(snapshot).toEqual({
      stale: ["old.txt"],
      upsert: ["new.txt"]
    });
  });

  it("keeps delete and create event routing explicit", () => {
    expect(watcherQueueSnapshotFromEvent({ eventType: "deleted", paths: ["gone.txt"] })).toEqual({
      stale: ["gone.txt"],
      upsert: []
    });
    expect(watcherQueueSnapshotFromEvent({ eventType: "created", paths: ["new.txt"] })).toEqual({
      stale: [],
      upsert: ["new.txt"]
    });
  });

  it("takes bounded watcher batches and leaves the remainder queued", () => {
    const staleQueue = new Set(["stale-1.txt", "shared.txt", "stale-2.txt"]);
    const upsertQueue = new Set(["upsert-1.txt", "shared.txt", "upsert-2.txt"]);

    const first = takeWatcherQueueBatch(staleQueue, upsertQueue, 3);

    expect(first).toEqual({
      stale: ["stale-1.txt"],
      upsert: ["upsert-1.txt", "shared.txt"]
    });
    expect(Array.from(staleQueue)).toEqual(["stale-2.txt"]);
    expect(Array.from(upsertQueue)).toEqual(["upsert-2.txt"]);

    const second = takeWatcherQueueBatch(staleQueue, upsertQueue, 3);

    expect(second).toEqual({
      stale: ["stale-2.txt"],
      upsert: ["upsert-2.txt"]
    });
    expect(staleQueue.size).toBe(0);
    expect(upsertQueue.size).toBe(0);
  });
});
