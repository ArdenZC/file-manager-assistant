import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DashboardStats, FileQueryResult, LibraryFilter, LibraryScope } from "../src/types/domain";
import {
  LIBRARY_PAGE_SIZE,
  LIBRARY_SCOPE_STORAGE_KEY,
  emptyPage,
  emptyStats,
  readPersistedLibraryScope,
  useFileLibraryStore
} from "../src/store/useFileLibraryStore";
import { useScanManagerStore } from "../src/store/useScanManagerStore";

const apiMocks = vi.hoisted(() => ({
  startScan: vi.fn(),
  getPagedFiles: vi.fn(),
  getStatsSummary: vi.fn(),
  dialogOpen: vi.fn()
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: apiMocks.dialogOpen
}));

vi.mock("../src/api/tauriApi", () => ({
  tauriApi: {
    startScan: apiMocks.startScan,
    getPagedFiles: apiMocks.getPagedFiles,
    getStatsSummary: apiMocks.getStatsSummary
  }
}));

const scanSummary = {
  root: "F:/Downloads",
  scanned: 1,
  files: 1,
  directories: 0,
  skipped: 0,
  errors: 0,
  elapsedMs: 12
};

function stats(): DashboardStats {
  return { ...emptyStats };
}

function page(): FileQueryResult {
  return { ...emptyPage, files: [] };
}

function installLocalStorage() {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: vi.fn((key: string) => store.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        store.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        store.delete(key);
      }),
      clear: vi.fn(() => {
        store.clear();
      })
    }
  });
  return globalThis.localStorage;
}

describe("library scope store", () => {
  beforeEach(() => {
    installLocalStorage();
    apiMocks.startScan.mockReset().mockResolvedValue(scanSummary);
    apiMocks.getPagedFiles.mockReset().mockResolvedValue(page());
    apiMocks.getStatsSummary.mockReset().mockResolvedValue(stats());
    useFileLibraryStore.setState({
      stats: emptyStats,
      libraryPage: emptyPage,
      selectedFileId: "",
      firstPageRequestId: 0,
      libraryFilter: "all" as LibraryFilter,
      scope: { kind: "current_scan", roots: [] }
    });
    useScanManagerStore.setState({
      selectedFolders: [],
      isScanning: false,
      defaultScanRoots: []
    });
  });

  it("sets current scan scope after scanPath succeeds", async () => {
    await useScanManagerStore.getState().scanPath("F:/Downloads");

    expect(useFileLibraryStore.getState().scope).toEqual({
      kind: "current_scan",
      roots: ["F:/Downloads"]
    });
  });

  it("refresh carries the active scope to stats and paged files", async () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Projects"] };
    useFileLibraryStore.getState().setScope(scope);

    await useFileLibraryStore.getState().refresh("pdf");

    expect(apiMocks.getStatsSummary).toHaveBeenCalledWith(scope);
    expect(apiMocks.getPagedFiles).toHaveBeenCalledWith(LIBRARY_PAGE_SIZE, 0, "pdf", scope, undefined);
  });

  it("refresh carries the active library filter to paged files", async () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Projects"] };
    useFileLibraryStore.getState().setScope(scope);
    useFileLibraryStore.getState().setLibraryFilter("review");

    await useFileLibraryStore.getState().refresh("pdf");

    expect(apiMocks.getStatsSummary).toHaveBeenCalledWith(scope);
    expect(apiMocks.getPagedFiles).toHaveBeenCalledWith(LIBRARY_PAGE_SIZE, 0, "pdf", scope, {
      libraryFilter: "review"
    });
  });

  it("switches to all indexed files explicitly", () => {
    useFileLibraryStore.getState().setScope({ kind: "all" });

    expect(useFileLibraryStore.getState().scope.kind).toBe("all");
  });

  it("scan button scans enabled default roots without opening the folder picker", async () => {
    useScanManagerStore.setState({
      defaultScanRoots: [
        {
          id: "downloads",
          path: "F:/Downloads",
          label: "Downloads",
          enabled: true,
          createdAt: "2026-06-22T00:00:00.000Z"
        },
        {
          id: "archive",
          path: "D:/Archive",
          label: "Archive",
          enabled: false,
          createdAt: "2026-06-22T00:00:00.000Z"
        },
        {
          id: "projects",
          path: "D:/Projects",
          label: "Projects",
          enabled: true,
          createdAt: "2026-06-22T00:00:00.000Z"
        }
      ]
    });

    await useScanManagerStore.getState().handleScan();

    expect(apiMocks.dialogOpen).not.toHaveBeenCalled();
    expect(apiMocks.startScan).toHaveBeenNthCalledWith(1, "F:/Downloads", false);
    expect(apiMocks.startScan).toHaveBeenNthCalledWith(2, "D:/Projects", false);
    expect(useFileLibraryStore.getState().scope).toEqual({
      kind: "current_scan",
      roots: ["F:/Downloads", "D:/Projects"]
    });
  });

  it("persists explicit scope changes to localStorage", () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Projects"] };

    useFileLibraryStore.getState().setScope(scope);

    expect(localStorage.setItem).toHaveBeenCalledWith(
      LIBRARY_SCOPE_STORAGE_KEY,
      JSON.stringify(scope)
    );
  });

  it("reads a persisted scope when localStorage has a valid scope", () => {
    const scope: LibraryScope = { kind: "current_scan", roots: ["F:/Downloads"] };
    localStorage.setItem(LIBRARY_SCOPE_STORAGE_KEY, JSON.stringify(scope));

    expect(readPersistedLibraryScope()).toEqual(scope);
  });
});
