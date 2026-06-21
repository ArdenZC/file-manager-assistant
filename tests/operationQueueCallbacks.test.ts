import { beforeEach, describe, expect, it } from "vitest";
import { useOperationQueueStore } from "../src/store/useOperationQueueStore";

describe("operation queue store callbacks", () => {
  beforeEach(() => {
    useOperationQueueStore.setState({
      previewNameOverrides: {},
      previews: [],
      displayPreviews: [],
      previewActionCount: 0
    });
  });

  it("keeps onRenamePreview stable across store updates", () => {
    const first = useOperationQueueStore.getState().onRenamePreview;

    useOperationQueueStore.getState().syncPreviews([]);

    expect(useOperationQueueStore.getState().onRenamePreview).toBe(first);
  });
});
