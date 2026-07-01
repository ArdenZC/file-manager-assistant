import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyFsWatchEvent,
  watcherQueueSnapshotFromEvent,
  mergeWatcherQueues,
  takeWatcherQueueBatch,
  type FsWatchEvent
} from "../src/hooks/fsWatcherQueue";
import { useFsWatcher } from "../src/hooks/useFsWatcher";
import type { Rule } from "../src/types/domain";

type EffectEntry = {
  deps?: unknown[];
  cleanup?: void | (() => void);
};

const reactMock = vi.hoisted(() => ({
  refs: [] as Array<{ current: unknown }>,
  effects: [] as EffectEntry[],
  refIndex: 0,
  effectIndex: 0
}));

const apiMocks = vi.hoisted(() => ({
  listen: vi.fn(),
  markFilesStaleByPaths: vi.fn(),
  upsertFilesByPaths: vi.fn(),
  executeRulesForPaths: vi.fn()
}));

vi.mock("react", () => ({
  useRef: (initialValue: unknown) => {
    const index = reactMock.refIndex++;
    reactMock.refs[index] ??= { current: initialValue };
    return reactMock.refs[index];
  },
  useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
    const index = reactMock.effectIndex++;
    const previous = reactMock.effects[index];
    const changed = !previous || !deps || !previous.deps || deps.some((dep, depIndex) => dep !== previous.deps?.[depIndex]);
    if (!changed) return;
    previous?.cleanup?.();
    reactMock.effects[index] = {
      deps,
      cleanup: effect()
    };
  }
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: apiMocks.listen
}));

vi.mock("../src/api/tauriApi", () => ({
  tauriApi: {
    markFilesStaleByPaths: apiMocks.markFilesStaleByPaths,
    upsertFilesByPaths: apiMocks.upsertFilesByPaths,
    executeRulesForPaths: apiMocks.executeRulesForPaths
  }
}));

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

describe("fs watcher hook registration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetHookHarness();
    apiMocks.listen.mockReset().mockResolvedValue(() => {});
    apiMocks.markFilesStaleByPaths.mockReset().mockResolvedValue(0);
    apiMocks.upsertFilesByPaths.mockReset().mockResolvedValue(1);
    apiMocks.executeRulesForPaths.mockReset().mockResolvedValue({
      scanned: 1,
      updated: 1,
      skipped: 0,
      needsConfirmation: 0
    });
  });

  afterEach(() => {
    cleanupHookHarness();
    vi.useRealTimers();
  });

  it("keeps queued fs events when rules change during the debounce window", async () => {
    const firstRules = [rule("first")];
    const secondRules = [rule("second")];
    const onRefreshData = vi.fn(async () => {});

    renderWatcher({ onRefreshData, rules: firstRules });

    const handler = apiMocks.listen.mock.calls[0][1] as (event: { payload: FsWatchEvent }) => void;
    handler({ payload: { eventType: "created", paths: ["F:/Projects/new.txt"] } });

    renderWatcher({ onRefreshData, rules: secondRules });

    expect(apiMocks.listen).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(500);
    await flushPromises();

    expect(apiMocks.upsertFilesByPaths).toHaveBeenCalledWith(["F:/Projects/new.txt"]);
    expect(apiMocks.executeRulesForPaths).toHaveBeenCalledWith(["F:/Projects/new.txt"], secondRules);
    expect(onRefreshData).toHaveBeenCalledOnce();
  });

  it("does not re-register the fs-event listener when rules change", async () => {
    const onRefreshData = vi.fn(async () => {});

    renderWatcher({ onRefreshData, rules: [rule("first")] });

    expect(apiMocks.listen).toHaveBeenCalledTimes(1);
    expect(apiMocks.listen).toHaveBeenCalledWith("fs-event", expect.any(Function));

    renderWatcher({ onRefreshData, rules: [rule("second")] });

    expect(apiMocks.listen).toHaveBeenCalledTimes(1);
  });
});

function renderWatcher({
  enabled = true,
  onRefreshData,
  rules
}: {
  enabled?: boolean;
  onRefreshData: () => Promise<void>;
  rules: Rule[];
}) {
  reactMock.refIndex = 0;
  reactMock.effectIndex = 0;
  useFsWatcher({ enabled, onRefreshData, rules });
}

function rule(id: string): Rule {
  return {
    id,
    name: id,
    source: "user",
    enabled: true,
    priority: 1,
    weight: 1,
    root_operator: "AND",
    groups: [],
    action: {},
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z"
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function resetHookHarness() {
  cleanupHookHarness();
  reactMock.refs = [];
  reactMock.effects = [];
  reactMock.refIndex = 0;
  reactMock.effectIndex = 0;
}

function cleanupHookHarness() {
  for (const effect of reactMock.effects) {
    effect.cleanup?.();
  }
  reactMock.effects = [];
}
