import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileQueryResult, FileRecord, LibraryScope } from "../src/types/domain";
import {
  ORGANIZE_QUEUE_MAX_FILES,
  ORGANIZE_QUEUE_PAGE_SIZE,
  useFileLibraryStore
} from "../src/store/useFileLibraryStore";

const apiMocks = vi.hoisted(() => ({
  getPagedFiles: vi.fn(),
  getStatsSummary: vi.fn()
}));

vi.mock("../src/api/tauriApi", () => ({
  tauriApi: {
    getPagedFiles: apiMocks.getPagedFiles,
    getStatsSummary: apiMocks.getStatsSummary
  }
}));

describe("organize queue loader", () => {
  beforeEach(() => {
    apiMocks.getPagedFiles.mockReset();
    apiMocks.getStatsSummary.mockReset();
    useFileLibraryStore.setState({
      organizeQueue: [],
      organizeQueueTotal: 0,
      organizeQueueTruncated: false,
      isLoadingOrganizeQueue: false,
      scope: { kind: "all" }
    });
  });

  it("loads the organize queue across paged file results", async () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Projects"] };
    apiMocks.getPagedFiles
      .mockResolvedValueOnce(page(0, ORGANIZE_QUEUE_PAGE_SIZE, 1200))
      .mockResolvedValueOnce(page(ORGANIZE_QUEUE_PAGE_SIZE, ORGANIZE_QUEUE_PAGE_SIZE, 1200))
      .mockResolvedValueOnce(page(ORGANIZE_QUEUE_PAGE_SIZE * 2, 200, 1200));

    await useFileLibraryStore.getState().loadOrganizeQueue(scope);

    expect(apiMocks.getPagedFiles).toHaveBeenCalledTimes(3);
    expect(apiMocks.getPagedFiles).toHaveBeenNthCalledWith(1, ORGANIZE_QUEUE_PAGE_SIZE, 0, undefined, scope);
    expect(apiMocks.getPagedFiles).toHaveBeenNthCalledWith(2, ORGANIZE_QUEUE_PAGE_SIZE, 500, undefined, scope);
    expect(apiMocks.getPagedFiles).toHaveBeenNthCalledWith(3, ORGANIZE_QUEUE_PAGE_SIZE, 1000, undefined, scope);
    expect(useFileLibraryStore.getState().organizeQueue).toHaveLength(1200);
    expect(useFileLibraryStore.getState().organizeQueueTotal).toBe(1200);
    expect(useFileLibraryStore.getState().organizeQueueTruncated).toBe(false);
    expect(useFileLibraryStore.getState().isLoadingOrganizeQueue).toBe(false);
  });

  it("marks the organize queue truncated when total exceeds the display limit", async () => {
    apiMocks.getPagedFiles.mockImplementation((limit: number, offset: number) =>
      Promise.resolve(page(offset, limit, ORGANIZE_QUEUE_MAX_FILES + 1))
    );

    await useFileLibraryStore.getState().loadOrganizeQueue({ kind: "all" });

    expect(apiMocks.getPagedFiles).toHaveBeenCalledTimes(6);
    expect(useFileLibraryStore.getState().organizeQueue).toHaveLength(ORGANIZE_QUEUE_MAX_FILES);
    expect(useFileLibraryStore.getState().organizeQueueTotal).toBe(ORGANIZE_QUEUE_MAX_FILES + 1);
    expect(useFileLibraryStore.getState().organizeQueueTruncated).toBe(true);
    expect(useFileLibraryStore.getState().isLoadingOrganizeQueue).toBe(false);
  });

  it("resets the organize queue when loading fails", async () => {
    useFileLibraryStore.setState({
      organizeQueue: [file("existing")],
      organizeQueueTotal: 1,
      organizeQueueTruncated: true
    });
    apiMocks.getPagedFiles.mockRejectedValueOnce(new Error("database unavailable"));

    await useFileLibraryStore.getState().loadOrganizeQueue({ kind: "all" });

    expect(useFileLibraryStore.getState().organizeQueue).toEqual([]);
    expect(useFileLibraryStore.getState().organizeQueueTotal).toBe(0);
    expect(useFileLibraryStore.getState().organizeQueueTruncated).toBe(false);
    expect(useFileLibraryStore.getState().isLoadingOrganizeQueue).toBe(false);
  });
});

function page(start: number, count: number, total: number): FileQueryResult {
  return {
    files: Array.from({ length: count }, (_, index) => file(`file-${start + index}`)),
    total,
    limit: ORGANIZE_QUEUE_PAGE_SIZE,
    offset: start
  };
}

function file(id: string): FileRecord {
  return {
    id,
    name: `${id}.txt`,
    path: `F:/Projects/${id}.txt`,
    directory: "F:/Projects",
    extension: "txt",
    size: 128,
    file_type: "Document",
    purpose: "Unknown",
    lifecycle: "Inbox",
    context: "",
    risk_level: "Normal",
    hash: null,
    created_at: "2026-06-21T00:00:00Z",
    modified_at: "2026-06-21T00:00:00Z",
    scanned_at: "2026-06-21T00:00:00Z",
    last_seen_at: "2026-06-21T00:00:00Z",
    is_hidden: false,
    is_deleted: false,
    is_duplicate: false,
    suggested_action: "Keep",
    suggested_target_path: "",
    suggested_name: "",
    confidence: 0.5,
    classification_reason: "",
    classification_status: "classified",
    matched_rules: [],
    requires_confirmation: false
  };
}
