import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Clock3,
  FolderSearch,
  LayoutGrid,
  ListChecks,
  LockKeyhole,
  Minus,
  Radar,
  RefreshCw,
  Search,
  Settings,
  SlidersHorizontal,
  Square,
  X
} from "lucide-react";
import type {
  CloseBehavior,
  FileQuery,
  FileQueryResult,
  FileRecord,
  FolderScanResult,
  Rule,
  ScanProgress
} from "./types/domain";
import { makeTranslator } from "./i18n";
import { formatDate } from "./utils/format";
import { CommandModal } from "./components/CommandModal";
import { AmbientMesh, CloseChoiceDialog, TitlebarTools, ZenMark } from "./components/ShellChrome";
import { demoFilePage, demoFiles, demoSnapshot } from "./mocks/demoData";
import { useAppStore } from "./store/useAppStore";
import type { ThemeMode } from "./types/ui";
import {
  applyPreviewNameOverride,
  createOperationPreviews,
  delay,
  detectBrowserPlatform,
  fileBelongsToRoots,
  filterFiles,
  preferredLanguage,
  preferredTheme,
  prefersDarkScheme,
  readableError
} from "./utils/viewHelpers";
import {
  HubView,
  RestoreView,
  RulesView,
  ScannerView,
  SettingsView,
  TimelineView,
  VaultView
} from "./views/AppViews";

export function App() {
  const language = useAppStore((state) => state.language);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const snapshot = useAppStore((state) => state.snapshot);
  const setSnapshot = useAppStore((state) => state.setSnapshot);
  const [systemDark, setSystemDark] = useState(() => prefersDarkScheme());
  const t = useMemo(() => makeTranslator(language), [language]);
  const [libraryPage, setLibraryPage] = useState<FileQueryResult>(demoFilePage);
  const [scopeFiles, setScopeFiles] = useState<FileRecord[]>(demoFiles);
  const [query, setQuery] = useState<FileQuery>({
    fileType: "All",
    purpose: "All",
    riskLevel: "All",
    sortBy: "modified_at",
    sortDirection: "desc"
  });
  const [selectedFileId, setSelectedFileId] = useState<string>(demoFiles[0]?.id ?? "");
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const [isScanning, setIsScanning] = useState(false);
  const [status, setStatus] = useState("");
  const [selectedFolders, setSelectedFolders] = useState<string[]>([]);
  const [activeScanRootPaths, setActiveScanRootPaths] = useState<string[]>([]);
  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const [isLibraryLoading, setIsLibraryLoading] = useState(false);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isCloseChoiceOpen, setIsCloseChoiceOpen] = useState(false);
  const [closeBehavior, setCloseBehaviorState] = useState<CloseBehavior>("ask");
  const [previewNameOverrides, setPreviewNameOverrides] = useState<Record<string, string>>({});
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const closeBehaviorRef = useRef<CloseBehavior>("ask");
  const libraryRequestIdRef = useRef(0);
  const scopeRequestIdRef = useRef(0);
  const fileManager = window.fileManager;
  const platform = fileManager?.platform ?? detectBrowserPlatform();
  const isWindows = platform === "win32";
  const hotkeyLabel = platform === "darwin" ? "⌘ K" : "Ctrl K";
  const hasNativeApi = typeof fileManager !== "undefined";
  const isSearchMode = new URLSearchParams(window.location.search).get("mode") === "search";
  const effectiveTheme: Exclude<ThemeMode, "system"> = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const libraryLimit = 50;

  const loadLibraryPage = useCallback(async (nextQuery: FileQuery, append = false, offset = 0) => {
    const requestId = ++libraryRequestIdRef.current;
    if (!fileManager) {
      const files = filterFiles(demoFiles, nextQuery);
      const nextFiles = files.slice(offset, offset + libraryLimit);
      setLibraryPage((current) => ({
        files: append ? [...current.files, ...nextFiles] : files.slice(0, libraryLimit),
        total: files.length,
        limit: libraryLimit,
        offset
      }));
      return;
    }
    setIsLibraryLoading(true);
    try {
      const page = await fileManager.queryFiles({ ...nextQuery, limit: libraryLimit, offset });
      if (requestId !== libraryRequestIdRef.current) return;
      setLibraryPage((current) => append
        ? { ...page, files: [...current.files, ...page.files], offset: 0 }
        : page
      );
      const firstFile = page.files[0];
      if (!append && firstFile) setSelectedFileId(firstFile.id);
    } finally {
      if (requestId === libraryRequestIdRef.current) setIsLibraryLoading(false);
    }
  }, [fileManager, libraryLimit]);

  const loadScopedFiles = useCallback(async (roots: string[]) => {
    const requestId = ++scopeRequestIdRef.current;
    if (!fileManager) {
      const files = roots.length ? demoFiles.filter((file) => fileBelongsToRoots(file, roots)) : demoFiles;
      setScopeFiles(files);
      return;
    }
    const page = await fileManager.queryFiles({
      roots,
      limit: 5000,
      offset: 0,
      sortBy: "modified_at",
      sortDirection: "desc"
    });
    if (requestId !== scopeRequestIdRef.current) return;
    setScopeFiles(page.files);
  }, [fileManager]);

  useEffect(() => {
    document.documentElement.classList.toggle("search-window-root", isSearchMode);
    document.body.classList.toggle("search-window-root", isSearchMode);
    return () => {
      document.documentElement.classList.remove("search-window-root");
      document.body.classList.remove("search-window-root");
    };
  }, [isSearchMode]);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return;
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", effectiveTheme === "dark");
    window.localStorage.setItem("zc-theme", theme);
  }, [effectiveTheme, theme]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === "zc-theme") {
        setTheme(preferredTheme());
      }
      if (!event.key || event.key === "zc-language" || event.key === "fma-language") {
        setLanguage(preferredLanguage());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  useEffect(() => {
    if (!fileManager) return;
    fileManager.getSnapshot().then((next) => {
      setSnapshot(next);
      const roots = next.scanRoots.map((root) => root.path);
      setActiveScanRootPaths(roots);
      void loadScopedFiles(roots);
      if (next.files.length) setSelectedFileId(next.files[0]?.id ?? "");
    });
  }, [fileManager, loadScopedFiles]);

  useEffect(() => {
    void loadLibraryPage(query, false, 0);
  }, [loadLibraryPage, query]);

  useEffect(() => {
    const unsubscribe = fileManager?.onScanProgress?.((progress) => {
      setScanProgress(progress);
    });
    return () => unsubscribe?.();
  }, [fileManager]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandOpen(true);
      }
      if (event.key === "Escape") {
        setIsCommandOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    const unsubscribe = fileManager?.onCommandOpen?.(() => {
      setTheme(preferredTheme());
      setLanguage(preferredLanguage());
      setIsCommandOpen(true);
    });
    return () => unsubscribe?.();
  }, [fileManager, setLanguage, setTheme]);

  useEffect(() => {
    const unsubscribe = fileManager?.onCommandHide?.(() => setIsCommandOpen(false));
    return () => unsubscribe?.();
  }, [fileManager]);

  useEffect(() => {
    closeBehaviorRef.current = closeBehavior;
  }, [closeBehavior]);

  useEffect(() => {
    if (!fileManager) return;
    fileManager.getCloseBehavior?.().then(setCloseBehaviorState).catch(() => undefined);
  }, [fileManager]);

  useEffect(() => {
    const unsubscribe = fileManager?.onCloseRequested?.(() => {
      const behavior = closeBehaviorRef.current;
      if (behavior === "ask") {
        setIsCloseChoiceOpen(true);
        return;
      }
      void fileManager.performClose?.(behavior === "quit" ? "quit" : "minimize");
    });
    return () => unsubscribe?.();
  }, [fileManager]);

  useEffect(() => {
    if (isCommandOpen) {
      window.setTimeout(() => commandInputRef.current?.focus(), 40);
    }
  }, [isCommandOpen]);

  useEffect(() => {
    if (isSearchMode) {
      setTheme(preferredTheme());
      setLanguage(preferredLanguage());
      setIsCommandOpen(true);
    }
  }, [isSearchMode, setLanguage, setTheme]);

  const scopedFiles = scopeFiles;
  const filteredFiles = libraryPage.files;
  const selectedFile =
    filteredFiles.find((file) => file.id === selectedFileId) ??
    scopedFiles.find((file) => file.id === selectedFileId) ??
    snapshot.files.find((file) => file.id === selectedFileId) ??
    filteredFiles[0] ??
    scopedFiles[0] ??
    snapshot.files[0];
  const previews = useMemo(() => createOperationPreviews(scopedFiles), [scopedFiles]);
  const displayPreviews = useMemo(
    () => previews.map((preview) => applyPreviewNameOverride(preview, previewNameOverrides[preview.id])),
    [previewNameOverrides, previews]
  );
  const previewActionCount = displayPreviews.filter((preview) => preview.status === "pending").length;

  useEffect(() => {
    setSelectedOperationIds(
      new Set(previews.filter((preview) => preview.selected_by_default).map((preview) => preview.id))
    );
    setPreviewNameOverrides({});
  }, [previews]);

  const nav = [
    { id: "scanner" as const, label: t("spaceScan"), icon: Radar },
    { id: "organize" as const, label: t("smartDispatch"), icon: LayoutGrid },
    { id: "library" as const, label: t("fileLibrary"), icon: Archive },
    { id: "preview" as const, label: t("previewExecute"), icon: ListChecks },
    { id: "rules" as const, label: t("ruleEngine"), icon: SlidersHorizontal },
    { id: "restore" as const, label: t("restoreRecords"), icon: Clock3 },
    { id: "settings" as const, label: t("settings"), icon: Settings }
  ];

  async function setCloseBehavior(next: CloseBehavior) {
    setCloseBehaviorState(next);
    if (fileManager?.setCloseBehavior) {
      setCloseBehaviorState(await fileManager.setCloseBehavior(next));
    }
  }

  async function refreshSnapshot() {
    if (!fileManager) return;
    const next = await fileManager.getSnapshot();
    setSnapshot(next);
    const roots = activeScanRootPaths.length ? activeScanRootPaths : next.scanRoots.map((root) => root.path);
    await Promise.all([
      loadScopedFiles(roots),
      loadLibraryPage(query, false, 0)
    ]);
    setSelectedFileId((current) => current || next.files[0]?.id || "");
  }

  async function handleScan() {
    setIsScanning(true);
    setScanProgress(null);
    try {
      if (fileManager) {
        const result = await fileManager.scanDefaults();
        if (result.canceled) {
          setStatus(t("scanCanceled"));
          return;
        }
        const roots = result.roots.map((root) => root.path);
        setActiveScanRootPaths(result.roots.map((root) => root.path));
        setSelectedFolders(result.roots.map((root) => root.path));
        const next = await fileManager.getSnapshot();
        setSnapshot(next);
        await Promise.all([
          loadLibraryPage(query, false, 0),
          loadScopedFiles(roots)
        ]);
        setStatus(`${t("success")}: ${result.files.length}`);
      } else {
        await delay(1200);
        setSnapshot(demoSnapshot);
        setScopeFiles(demoFiles);
        setStatus("");
      }
    } catch (error) {
      setStatus(readableError(error));
    } finally {
      setIsScanning(false);
    }
  }

  async function handleChooseFolders() {
    setIsScanning(true);
    setScanProgress(null);
    try {
      if (fileManager) {
        const result: FolderScanResult = await fileManager.chooseAndScanFolders();
        if (result.canceled) {
          setStatus(result.selectedPaths.length ? t("scanCanceled") : t("noFolderSelected"));
          return;
        }
        setSelectedFolders(result.selectedPaths);
        const roots = result.roots.map((root) => root.path);
        setActiveScanRootPaths(roots);
        const next = await fileManager.getSnapshot();
        setSnapshot(next);
        await Promise.all([
          loadScopedFiles(roots),
          loadLibraryPage(query, false, 0)
        ]);
        setStatus(`${t("success")}: ${result.selectedPaths.length} / ${result.files.length}`);
      } else {
        await delay(900);
        const sampleFolders = ["C:/Users/example/Downloads", "C:/Users/example/Desktop"];
        setSelectedFolders(sampleFolders);
        setSnapshot(demoSnapshot);
        setScopeFiles(demoFiles);
        setStatus(t("folderChooserUnavailable"));
      }
    } catch (error) {
      setStatus(readableError(error));
    } finally {
      setIsScanning(false);
    }
  }

  async function saveRule(rule: Rule) {
    if (fileManager) {
      await fileManager.saveRule(rule);
      const next = await fileManager.reapplyRules();
      setSnapshot(next);
      await Promise.all([
        loadScopedFiles(activeScanRootPaths),
        loadLibraryPage(query, false, 0)
      ]);
    } else {
      setSnapshot((current) => ({ ...current, rules: [...current.rules, rule] }));
    }
  }

  async function executeSelected() {
    const operations = displayPreviews.filter((preview) => selectedOperationIds.has(preview.id) && preview.is_executable !== false);
    if (!operations.length) return;
    if (fileManager) {
      await fileManager.executeOperations({ operations });
      await refreshSnapshot();
    } else {
      await loadLibraryPage(query, false, 0);
    }
    setSelectedOperationIds(new Set());
  }

  async function cancelScan() {
    await fileManager?.cancelScan?.();
    setStatus(t("scanCanceling"));
  }

  function handleWindowAction(action: "minimize" | "maximize" | "close") {
    if (action === "close") {
      requestClose();
      return;
    }
    void fileManager?.windowControl?.(action);
  }

  function requestClose() {
    const behavior = closeBehaviorRef.current;
    if (!fileManager?.performClose) {
      void fileManager?.windowControl?.("close");
      return;
    }
    if (behavior === "ask") {
      setIsCloseChoiceOpen(true);
      return;
    }
    void fileManager.performClose(behavior === "quit" ? "quit" : "minimize");
  }

  async function resolveCloseChoice(action: "minimize" | "quit", remember: boolean) {
    if (remember) {
      await setCloseBehavior(action);
    }
    setIsCloseChoiceOpen(false);
    await fileManager?.performClose?.(action);
  }

  const activeLabel = nav.find((item) => item.id === view)?.label ?? t("spaceScan");
  const scannerLastScanLabel = snapshot.stats.lastScannedAt ? formatDate(snapshot.stats.lastScannedAt) : t("notScannedYet");
  const headingDescription =
    view === "scanner"
      ? `${t("lastScan")}: ${scannerLastScanLabel}`
      : snapshot.stats.lastScannedAt
        ? `${t("lastScan")}: ${formatDate(snapshot.stats.lastScannedAt)}`
        : t("demoMode");

  if (isSearchMode) {
    return (
      <div className="zen-app search-window">
        {isCommandOpen && (
          <CommandModal
            inputRef={commandInputRef}
            files={snapshot.files}
            setView={setView}
            setSelectedFileId={setSelectedFileId}
            onClose={() => {
              setIsCommandOpen(false);
              void fileManager?.hideSearch?.();
            }}
            platform={platform}
            t={t}
            standalone
          />
        )}
      </div>
    );
  }

  return (
    <div className="zen-app">
      <AmbientMesh />

      <header className={`native-titlebar ${isWindows ? "is-windows" : "is-macos"}`}>
        <div className="titlebar-left">
          {!isWindows ? (
            <div className="window-controls" aria-label="Window controls">
              <button className="traffic-dot red" onClick={() => handleWindowAction("close")} aria-label={t("close")} />
              <button
                className="traffic-dot yellow"
                onClick={() => handleWindowAction("minimize")}
                aria-label={t("minimize")}
              />
              <button
                className="traffic-dot green"
                onClick={() => handleWindowAction("maximize")}
                aria-label={t("maximize")}
              />
            </div>
          ) : (
            <TitlebarTools
              language={language}
              theme={theme}
              effectiveTheme={effectiveTheme}
              setLanguage={setLanguage}
              setTheme={setTheme}
            />
          )}
        </div>

        <div className="titlebar-center">
          <button className="spotlight-trigger" onClick={() => setIsCommandOpen(true)}>
            <Search size={15} />
            <span>{t("globalSearch")}</span>
            <kbd>{hotkeyLabel}</kbd>
          </button>
        </div>

        <div className="titlebar-right">
          {!isWindows ? (
            <TitlebarTools
              language={language}
              theme={theme}
              effectiveTheme={effectiveTheme}
              setLanguage={setLanguage}
              setTheme={setTheme}
            />
          ) : (
            <div className="win-controls" aria-label="Window controls">
              <button className="win-btn" onClick={() => handleWindowAction("minimize")} aria-label={t("minimize")}>
                <Minus size={15} strokeWidth={1.6} />
              </button>
              <button className="win-btn" onClick={() => handleWindowAction("maximize")} aria-label={t("maximize")}>
                <Square size={12} strokeWidth={1.6} />
              </button>
              <button className="win-btn close" onClick={() => handleWindowAction("close")} aria-label={t("close")}>
                <X size={16} strokeWidth={1.6} />
              </button>
            </div>
          )}
        </div>
      </header>

      <div className="zen-shell">
        <aside className="zen-sidebar">
          <div className="brand-block">
            <ZenMark />
            <div>
              <strong>{t("appName")}</strong>
              <span>{t("appSubtitle")}</span>
            </div>
          </div>

          <nav className="zen-nav">
            {nav.map((item, index) => (
              <button
                key={item.id}
                className={`zen-nav-item ${view === item.id ? "active" : ""} ${index === 4 ? "with-divider" : ""}`}
                onClick={() => setView(item.id)}
              >
                <item.icon size={18} />
                <span>{item.label}</span>
                {item.id === "preview" && previewActionCount > 0 && <em>{previewActionCount}</em>}
              </button>
            ))}
          </nav>

          <div className="privacy-card">
            <LockKeyhole size={18} />
            <div>
              <strong>{t("privateByDefault")}</strong>
              <span>{t("privacyLine")}</span>
            </div>
          </div>
        </aside>

        <main className="zen-workspace">
          <div className="view-heading">
            <div>
              <h1>{activeLabel}</h1>
              <p>{headingDescription}</p>
            </div>
            {view !== "scanner" && (
              <div className="view-heading-actions">
                <button className="glass-button" onClick={handleChooseFolders} disabled={isScanning}>
                  <FolderSearch size={17} />
                  <span>{t("chooseFolders")}</span>
                </button>
                <button className="glass-button primary" onClick={handleScan} disabled={isScanning}>
                  <RefreshCw size={17} className={isScanning ? "spin" : ""} />
                  <span>{t("scanCommon")}</span>
                </button>
              </div>
            )}
          </div>

          {status && <div className="system-toast">{status}</div>}

          <div className="view-stage">
            {view === "scanner" && (
              <ScannerView
                snapshot={snapshot}
                files={scopedFiles}
                activeRootPaths={activeScanRootPaths}
                selectedFolders={selectedFolders}
                isScanning={isScanning}
                scanProgress={scanProgress}
                chooseFolders={handleChooseFolders}
                scanCommon={handleScan}
                cancelScan={cancelScan}
                t={t}
              />
            )}
            {view === "organize" && (
              <HubView
                files={scopedFiles}
                setView={setView}
                t={t}
              />
            )}
            {view === "library" && (
              <VaultView
                page={libraryPage}
                selectedFile={selectedFile}
                query={query}
                setQuery={setQuery}
                setSelectedFileId={setSelectedFileId}
                isLoading={isLibraryLoading}
                onLoadMore={() => loadLibraryPage(query, true, libraryPage.files.length)}
                t={t}
              />
            )}
            {view === "preview" && (
              <TimelineView
                previews={displayPreviews}
                selectedIds={selectedOperationIds}
                setSelectedIds={setSelectedOperationIds}
                onRenamePreview={(id, name) =>
                  setPreviewNameOverrides((current) => ({ ...current, [id]: name }))
                }
                executeSelected={executeSelected}
                t={t}
              />
            )}
            {view === "rules" && <RulesView rules={snapshot.rules} onSave={saveRule} t={t} />}
            {view === "restore" && <RestoreView hasNativeApi={hasNativeApi} t={t} />}
            {view === "settings" && (
              <SettingsView
                language={language}
                setLanguage={setLanguage}
                theme={theme}
                setTheme={setTheme}
                platform={platform}
                snapshot={snapshot}
                setSnapshot={setSnapshot}
                hasNativeApi={hasNativeApi}
                closeBehavior={closeBehavior}
                setCloseBehavior={setCloseBehavior}
                t={t}
              />
            )}
          </div>
        </main>
      </div>

      {isCommandOpen && (
        <CommandModal
          inputRef={commandInputRef}
          files={snapshot.files}
          setView={setView}
          setSelectedFileId={setSelectedFileId}
          onClose={() => setIsCommandOpen(false)}
          platform={platform}
          t={t}
        />
      )}
      {isCloseChoiceOpen && (
        <CloseChoiceDialog
          t={t}
          onCancel={() => setIsCloseChoiceOpen(false)}
          onChoose={resolveCloseChoice}
        />
      )}
    </div>
  );
}
