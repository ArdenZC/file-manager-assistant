import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("scan manager progress callbacks", () => {
  it("refreshes file data only from scan-complete and not scan-progress", () => {
    const storeSource = readFileSync(
      resolve("src/store/useScanManagerStore.ts"),
      "utf8"
    );
    const progressHandler = storeSource.slice(
      storeSource.indexOf("tauriApi.onScanProgress"),
      storeSource.indexOf("tauriApi.onScanBatch")
    );
    const completeHandler = storeSource.slice(
      storeSource.indexOf("tauriApi.onScanComplete"),
      storeSource.indexOf("tauriApi.onScanError")
    );

    expect(progressHandler).not.toContain("useFileLibraryStore.getState().refresh");
    expect(completeHandler).toContain("useFileLibraryStore.getState().refresh");
  });
});
