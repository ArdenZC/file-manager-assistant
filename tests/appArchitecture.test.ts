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

  it("allows folder picking through the dialog open permission only", () => {
    const capability = JSON.parse(read("src-tauri/capabilities/default.json")) as {
      permissions: string[];
    };

    expect(capability.permissions).toContain("dialog:allow-open");
    expect(capability.permissions).not.toContain("dialog:allow-save");
  });

  it("keeps scanner totals and vault filters tied to their real state", () => {
    const scanner = read("src/views/scanner/ScannerView.tsx");
    const vault = read("src/views/vault/VaultView.tsx");

    expect(scanner).toContain("const scopedTotalSize = stats.totalSize");
    expect(scanner).not.toContain("files.reduce((sum, file) => sum + file.size");
    expect(vault).toContain('useState<LibraryFilter>("all")');
    expect(vault).toContain("tauriApi.getPagedFiles(LIBRARY_PAGE_SIZE, offset, debouncedSearchQuery, scope, filters)");
    expect(vault).not.toContain("setSearchQuery(filter.key)");
  });

  it("does not rebuild operation previews from the current paged library rows", () => {
    const runtimeProviders = read("src/components/AppRuntimeProviders.tsx");
    const bootstrapper = runtimeProviders.slice(
      runtimeProviders.indexOf("function StoreRuntimeBootstrapper"),
      runtimeProviders.indexOf("function arraysEqual")
    );

    expect(bootstrapper).not.toContain("libraryPage.files");
    expect(bootstrapper).not.toContain("syncPreviews(files)");
  });

  it("reapplies changed rules only from an explicit RulesView action", () => {
    const rulesView = read("src/views/rules/RulesView.tsx");
    const runtimeProviders = read("src/components/AppRuntimeProviders.tsx");
    const saveRule = runtimeProviders.slice(
      runtimeProviders.indexOf("const saveRule"),
      runtimeProviders.indexOf("const toggleRuleEnabled")
    );

    expect(rulesView).toContain("reapplyRulesToCurrentScope");
    expect(rulesView).toContain('"all_changed_or_rule_changed"');
    expect(saveRule).not.toContain("executeRulesForScope");
  });
});
