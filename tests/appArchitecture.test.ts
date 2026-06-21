import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), "utf8");
}

describe("app render architecture", () => {
  it("keeps high-frequency state and business singletons out of App.tsx", () => {
    const app = read("src/App.tsx");

    expect(app).not.toContain("searchQuery");
    expect(app).not.toContain("toast");
    expect(app).not.toContain("useFileLibrary(");
    expect(app).not.toContain("useScanManager(");
    expect(app).not.toContain("useOperationQueue(");
    expect(app).not.toContain("FileLibraryProvider");
    expect(app).not.toContain("ScanProvider");
    expect(app).not.toContain("OperationQueueProvider");
  });

  it("uses Zustand stores instead of React context for file, scan, and operation queues", () => {
    const contexts = read("src/contexts/AppContexts.tsx");
    const fileLibraryStore = read("src/store/useFileLibraryStore.ts");
    const scanStore = read("src/store/useScanManagerStore.ts");
    const operationStore = read("src/store/useOperationQueueStore.ts");

    expect(contexts).not.toContain("FileLibraryProvider");
    expect(contexts).not.toContain("ScanProvider");
    expect(contexts).not.toContain("OperationQueueProvider");
    expect(fileLibraryStore).toContain("create<FileLibraryStore>");
    expect(scanStore).toContain("create<ScanManagerStore>");
    expect(operationStore).toContain("create<OperationQueueStore>");
  });
});
