import { describe, expect, it } from "vitest";
import {
  classifyFsWatchEvent,
  mergeWatcherQueues,
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

  it("routes path-only events to upsert unless remove flags are present", () => {
    const event: FsWatchEvent = { paths: ["a.txt"] };

    expect(classifyFsWatchEvent(event)).toBe("upsert");
  });

  it("lets upsert win when the same path appears in both queues", () => {
    const merged = mergeWatcherQueues(new Set(["a.txt", "stale.txt"]), new Set(["a.txt"]));

    expect(merged.stale).toEqual(["stale.txt"]);
    expect(merged.upsert).toEqual(["a.txt"]);
  });
});
