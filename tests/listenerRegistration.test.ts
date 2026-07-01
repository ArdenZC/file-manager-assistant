import { beforeEach, describe, expect, it, vi } from "vitest";
import { useOperationQueueStore } from "../src/store/useOperationQueueStore";
import { useScanManagerStore } from "../src/store/useScanManagerStore";

const apiMocks = vi.hoisted(() => ({
  getOperationLogs: vi.fn(),
  onOperationProgress: vi.fn(),
  onScanProgress: vi.fn(),
  onScanBatch: vi.fn(),
  onScanComplete: vi.fn(),
  onScanError: vi.fn(),
  dialogOpen: vi.fn()
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: apiMocks.dialogOpen
}));

vi.mock("../src/api/tauriApi", () => ({
  tauriApi: {
    getOperationLogs: apiMocks.getOperationLogs,
    onOperationProgress: apiMocks.onOperationProgress,
    onScanProgress: apiMocks.onScanProgress,
    onScanBatch: apiMocks.onScanBatch,
    onScanComplete: apiMocks.onScanComplete,
    onScanError: apiMocks.onScanError
  }
}));

describe("listener registration guards", () => {
  beforeEach(() => {
    apiMocks.getOperationLogs.mockReset().mockResolvedValue([]);
    apiMocks.onOperationProgress.mockReset().mockResolvedValue(() => {});
    apiMocks.onScanProgress.mockReset().mockResolvedValue(() => {});
    apiMocks.onScanBatch.mockReset().mockResolvedValue(() => {});
    apiMocks.onScanComplete.mockReset().mockResolvedValue(() => {});
    apiMocks.onScanError.mockReset().mockResolvedValue(() => {});

    useOperationQueueStore.setState({
      listenersRegistered: false,
      registrationPromise: null,
      unlistener: undefined,
      operationLogs: []
    });
    useScanManagerStore.setState({
      listenersRegistered: false,
      registrationPromise: null,
      unlisteners: [],
      scanState: {
        status: "idle",
        progress: null,
        entries: [],
        error: null
      }
    });
  });

  it("allows scan listener registration to retry after an initial failure", async () => {
    apiMocks.onScanProgress
      .mockRejectedValueOnce(new Error("scan listener failed"))
      .mockResolvedValueOnce(() => {});

    await useScanManagerStore.getState().initializeScanListeners();

    expect(useScanManagerStore.getState().listenersRegistered).toBe(false);
    expect(useScanManagerStore.getState().registrationPromise).toBeNull();

    await useScanManagerStore.getState().initializeScanListeners();

    expect(apiMocks.onScanProgress).toHaveBeenCalledTimes(2);
    expect(useScanManagerStore.getState().listenersRegistered).toBe(true);
    expect(useScanManagerStore.getState().registrationPromise).toBeNull();
  });

  it("deduplicates concurrent scan listener registration calls", async () => {
    const pendingScanProgress = deferred<() => void>();
    apiMocks.onScanProgress.mockReturnValueOnce(pendingScanProgress.promise);

    const first = useScanManagerStore.getState().initializeScanListeners();
    const second = useScanManagerStore.getState().initializeScanListeners();

    expect(second).toBe(first);
    expect(apiMocks.onScanProgress).toHaveBeenCalledTimes(1);
    expect(apiMocks.onScanBatch).toHaveBeenCalledTimes(1);
    expect(apiMocks.onScanComplete).toHaveBeenCalledTimes(1);
    expect(apiMocks.onScanError).toHaveBeenCalledTimes(1);

    pendingScanProgress.resolve(() => {});
    await Promise.all([first, second]);

    expect(useScanManagerStore.getState().listenersRegistered).toBe(true);
  });

  it("allows operation listener registration to retry after an initial failure", async () => {
    apiMocks.onOperationProgress
      .mockRejectedValueOnce(new Error("operation listener failed"))
      .mockResolvedValueOnce(() => {});

    await useOperationQueueStore.getState().initializeOperationQueue();

    expect(useOperationQueueStore.getState().listenersRegistered).toBe(false);
    expect(useOperationQueueStore.getState().registrationPromise).toBeNull();

    await useOperationQueueStore.getState().initializeOperationQueue();

    expect(apiMocks.onOperationProgress).toHaveBeenCalledTimes(2);
    expect(useOperationQueueStore.getState().listenersRegistered).toBe(true);
    expect(useOperationQueueStore.getState().registrationPromise).toBeNull();
  });

  it("deduplicates concurrent operation listener registration calls", async () => {
    const pendingLogs = deferred<unknown[]>();
    apiMocks.getOperationLogs.mockReturnValueOnce(pendingLogs.promise);

    const first = useOperationQueueStore.getState().initializeOperationQueue();
    const second = useOperationQueueStore.getState().initializeOperationQueue();

    expect(second).toBe(first);
    expect(apiMocks.getOperationLogs).toHaveBeenCalledTimes(1);
    expect(apiMocks.onOperationProgress).not.toHaveBeenCalled();

    pendingLogs.resolve([]);
    await Promise.all([first, second]);

    expect(apiMocks.onOperationProgress).toHaveBeenCalledTimes(1);
    expect(useOperationQueueStore.getState().listenersRegistered).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
