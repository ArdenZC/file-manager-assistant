import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LibraryScope, OperationPreview } from "../src/types/domain";
import { useOperationQueueStore } from "../src/store/useOperationQueueStore";
import { useFileLibraryStore } from "../src/store/useFileLibraryStore";
import { useRulesStore } from "../src/store/useRulesStore";

const apiMocks = vi.hoisted(() => ({
  executeRulesForScope: vi.fn(),
  getOperationPreviewsForScope: vi.fn(),
  getOperationLogs: vi.fn(),
  onOperationProgress: vi.fn(),
  executeMoves: vi.fn(),
  restoreMoves: vi.fn(),
  cancelOperations: vi.fn()
}));

vi.mock("../src/api/tauriApi", () => ({
  tauriApi: {
    executeRulesForScope: apiMocks.executeRulesForScope,
    getOperationPreviewsForScope: apiMocks.getOperationPreviewsForScope,
    getOperationLogs: apiMocks.getOperationLogs,
    onOperationProgress: apiMocks.onOperationProgress,
    executeMoves: apiMocks.executeMoves,
    restoreMoves: apiMocks.restoreMoves,
    cancelOperations: apiMocks.cancelOperations
  }
}));

function preview(id: string, selectedByDefault: boolean): OperationPreview {
  return {
    id,
    fileId: `file-${id}`,
    operation_type: "move",
    source_path: `F:/Downloads/${id}.txt`,
    target_path: `F:/Downloads/ZenCanvas/${id}.txt`,
    old_name: `${id}.txt`,
    new_name: `${id}.txt`,
    status: "pending",
    risk_level: "Normal",
    confidence: 0.9,
    requires_confirmation: !selectedByDefault,
    reason: "test",
    selected_by_default: selectedByDefault,
    is_executable: true,
    editable_new_name: true
  };
}

describe("operation queue store callbacks", () => {
  beforeEach(() => {
    apiMocks.executeRulesForScope.mockReset().mockResolvedValue({
      scanned: 0,
      updated: 0,
      skipped: 0,
      needsConfirmation: 0
    });
    apiMocks.getOperationPreviewsForScope.mockReset().mockResolvedValue({
      previews: [],
      total: 0,
      limit: 1000,
      offset: 0,
      truncated: false,
      hasMore: false
    });
    apiMocks.getOperationLogs.mockReset().mockResolvedValue([]);
    apiMocks.onOperationProgress.mockReset().mockResolvedValue(() => {});
    useOperationQueueStore.setState({
      previewNameOverrides: {},
      previews: [],
      displayPreviews: [],
      previewActionCount: 0,
      selectedOperationIds: new Set(),
      previewScope: null,
      previewTotal: 0,
      previewLimit: 0,
      previewOffset: 0,
      previewTruncated: false,
      previewHasMore: false
    });
    useRulesStore.setState({ rules: [] });
    useFileLibraryStore.setState({
      scope: { kind: "current_scan", roots: [] },
      refresh: vi.fn(async () => {})
    });
  });

  it("keeps onRenamePreview stable across store updates", () => {
    const first = useOperationQueueStore.getState().onRenamePreview;

    useOperationQueueStore.getState().syncPreviews([]);

    expect(useOperationQueueStore.getState().onRenamePreview).toBe(first);
  });

  it("loads dispatch previews from the full active scope after rule execution", async () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Downloads"] };
    const refresh = vi.fn(async () => {});
    const previews = [preview("selected", true), preview("manual", false)];
    apiMocks.executeRulesForScope.mockResolvedValue({
      scanned: 60,
      updated: 60,
      skipped: 0,
      needsConfirmation: 1
    });
    apiMocks.getOperationPreviewsForScope.mockResolvedValue({
      previews,
      total: 60,
      limit: 1000,
      offset: 0,
      truncated: false,
      hasMore: false
    });
    useFileLibraryStore.setState({ scope, refresh });

    await useOperationQueueStore.getState().runDispatch();

    expect(apiMocks.executeRulesForScope).toHaveBeenCalledWith(scope, [], "inbox_only");
    expect(refresh).toHaveBeenCalledOnce();
    expect(apiMocks.getOperationPreviewsForScope).toHaveBeenCalledWith(scope);
    expect(useOperationQueueStore.getState().displayPreviews).toEqual(previews);
    expect(useOperationQueueStore.getState().selectedOperationIds).toEqual(new Set(["selected"]));
    expect(useOperationQueueStore.getState().previewScope).toEqual(scope);
    expect(useOperationQueueStore.getState().previewTotal).toBe(60);
  });

  it("loads additional preview pages without dropping existing selections", async () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Downloads"] };
    const first = preview("first", true);
    const second = preview("second", true);
    const third = preview("third", true);

    useOperationQueueStore.getState().setPreviewResult({
      previews: [first, second],
      total: 3,
      limit: 2,
      offset: 0,
      truncated: true,
      hasMore: true
    }, scope);
    apiMocks.getOperationPreviewsForScope.mockResolvedValueOnce({
      previews: [third],
      total: 3,
      limit: 2,
      offset: 2,
      truncated: false,
      hasMore: false
    });

    await useOperationQueueStore.getState().loadMorePreviews();

    expect(apiMocks.getOperationPreviewsForScope).toHaveBeenCalledWith(scope, undefined, 2, 2);
    expect(useOperationQueueStore.getState().displayPreviews.map((item) => item.id)).toEqual([
      "first",
      "second",
      "third"
    ]);
    expect(useOperationQueueStore.getState().selectedOperationIds).toEqual(
      new Set(["first", "second", "third"])
    );
    expect(useOperationQueueStore.getState().previewTruncated).toBe(false);
  });
});
