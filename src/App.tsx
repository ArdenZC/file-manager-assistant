import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronRight,
  Clock3,
  File,
  Folder,
  FolderSearch,
  Languages,
  LayoutGrid,
  ListChecks,
  LockKeyhole,
  Minus,
  Monitor,
  Moon,
  Play,
  Plus,
  Radar,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Sun,
  X
} from "lucide-react";
import type {
  AppSnapshot,
  CloseBehavior,
  DefaultScanFolder,
  FileQuery,
  FileQueryResult,
  FileRecord,
  FolderNamingLanguage,
  FolderScanResult,
  OperationLog,
  OperationPreview,
  RestoreBatch,
  RestorePreview,
  RestoreRetentionDays,
  Rule,
  ScanProgress,
  SearchResult,
  SearchSource
} from "./types/domain";
import { type Language, makeTranslator } from "./i18n";
import { formatBytes, formatDate, percent } from "./utils/format";

type View = "scanner" | "organize" | "library" | "preview" | "rules" | "restore" | "settings";
type ThemeMode = "system" | "light" | "dark";
type Translator = ReturnType<typeof makeTranslator>;

const demoFiles = createDemoFiles();
const demoSnapshot: AppSnapshot = {
  stats: {
    totalFiles: demoFiles.length,
    totalSize: demoFiles.reduce((sum, file) => sum + file.size, 0),
    diskTotalSize: 512 * 1024 * 1024 * 1024,
    diskFreeSize: 384 * 1024 * 1024 * 1024,
    diskUsageRatio: demoFiles.reduce((sum, file) => sum + file.size, 0) / (512 * 1024 * 1024 * 1024),
    duplicateFiles: demoFiles.filter((file) => file.is_duplicate).length,
    largeFiles: 1,
    sensitiveFiles: demoFiles.filter((file) => file.risk_level === "Sensitive").length,
    needsConfirmation: demoFiles.filter((file) => file.requires_confirmation).length,
    byType: demoFiles.reduce<Record<string, number>>((acc, file) => {
      acc[file.file_type] = (acc[file.file_type] ?? 0) + 1;
      return acc;
    }, {}),
    byLifecycle: demoFiles.reduce<Record<string, number>>((acc, file) => {
      acc[file.lifecycle] = (acc[file.lifecycle] ?? 0) + 1;
      return acc;
    }, {}),
    lastScannedAt: null
  },
  files: demoFiles,
  rules: createDemoRules(),
  operations: [],
  scanRoots: [],
  searchSources: [
    {
      id: "demo-source",
      label: "Downloads",
      path: "C:/Users/example/Downloads",
      type: "user_space",
      enabled: true,
      is_stale: false,
      indexed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ],
  searchIndex: {
    total_files: demoFiles.length,
    indexed_files: demoFiles.length,
    last_indexed_at: null,
    stale_sources: 0
  }
};
const demoFilePage: FileQueryResult = {
  files: demoFiles.slice(0, 50),
  total: demoFiles.length,
  limit: 50,
  offset: 0
};

export function App() {
  const [language, setLanguageState] = useState<Language>(() => preferredLanguage());
  const [theme, setThemeState] = useState<ThemeMode>(() => preferredTheme());
  const [systemDark, setSystemDark] = useState(() => prefersDarkScheme());
  const t = useMemo(() => makeTranslator(language), [language]);
  const [view, setView] = useState<View>("scanner");
  const [snapshot, setSnapshot] = useState<AppSnapshot>(demoSnapshot);
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
        setThemeState(preferredTheme());
      }
      if (!event.key || event.key === "zc-language" || event.key === "fma-language") {
        setLanguageState(preferredLanguage());
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
      setThemeState(preferredTheme());
      setLanguageState(preferredLanguage());
      setIsCommandOpen(true);
    });
    return () => unsubscribe?.();
  }, [fileManager]);

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
      setThemeState(preferredTheme());
      setLanguageState(preferredLanguage());
      setIsCommandOpen(true);
    }
  }, [isSearchMode]);

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

  function setLanguage(next: Language) {
    setLanguageState(next);
    window.localStorage.setItem("zc-language", next);
  }

  function setTheme(next: ThemeMode) {
    setThemeState(next);
  }

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

function ZenMark() {
  return (
    <div className="zen-mark" aria-hidden="true">
      <span className="zen-orb" />
      <span className="zen-glass" />
    </div>
  );
}

function AmbientMesh() {
  return (
    <div className="ambient-mesh" aria-hidden="true">
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
    </div>
  );
}

function TitlebarTools({
  language,
  theme,
  effectiveTheme,
  setLanguage,
  setTheme
}: {
  language: Language;
  theme: ThemeMode;
  effectiveTheme: Exclude<ThemeMode, "system">;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeMode) => void;
}) {
  return (
    <div className="titlebar-tools">
      <button className="round-tool" onClick={() => setTheme(effectiveTheme === "dark" ? "light" : "dark")}>
        {theme === "system" ? <Monitor size={17} /> : effectiveTheme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
      <button className="lang-toggle" onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>
        <Languages size={16} />
        <span>{language === "zh" ? "EN" : "中文"}</span>
      </button>
    </div>
  );
}

function CloseChoiceDialog({
  t,
  onCancel,
  onChoose
}: {
  t: Translator;
  onCancel: () => void;
  onChoose: (action: "minimize" | "quit", remember: boolean) => Promise<void>;
}) {
  const [remember, setRemember] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState<"minimize" | "quit" | null>(null);

  async function choose(action: "minimize" | "quit") {
    setIsSubmitting(action);
    await onChoose(action, remember);
  }

  return (
    <div className="choice-backdrop" role="dialog" aria-modal="true">
      <section className="choice-dialog glass-panel">
        <div className="choice-icon">
          <ZenMark />
        </div>
        <div>
          <h2>{t("closeChoiceTitle")}</h2>
          <p>{t("closeChoiceDesc")}</p>
        </div>
        <label className="remember-choice">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>{t("doNotAskAgain")}</span>
        </label>
        <div className="choice-actions">
          <button className="glass-button" onClick={onCancel} disabled={isSubmitting !== null}>
            {t("cancel")}
          </button>
          <button className="glass-button" onClick={() => void choose("quit")} disabled={isSubmitting !== null}>
            {t("quitApp")}
          </button>
          <button className="glass-button primary" onClick={() => void choose("minimize")} disabled={isSubmitting !== null}>
            {t("minimizeToTray")}
          </button>
        </div>
      </section>
    </div>
  );
}

function ScannerView({
  snapshot,
  files,
  activeRootPaths,
  selectedFolders,
  isScanning,
  scanProgress,
  chooseFolders,
  scanCommon,
  cancelScan,
  t
}: {
  snapshot: AppSnapshot;
  files: FileRecord[];
  activeRootPaths: string[];
  selectedFolders: string[];
  isScanning: boolean;
  scanProgress: ScanProgress | null;
  chooseFolders: () => Promise<void>;
  scanCommon: () => Promise<void>;
  cancelScan: () => Promise<void>;
  t: Translator;
}) {
  const activeRoots = activeRootPaths.length
    ? snapshot.scanRoots.filter((root) => activeRootPaths.some((rootPath) => samePathLike(root.path, rootPath)))
    : snapshot.scanRoots;
  const scopedTotalSize = files.reduce((sum, file) => sum + file.size, 0);
  const scopedDiskTotal = sumUniqueDiskTotal(activeRoots) || snapshot.stats.diskTotalSize;
  const clutterItems = files.filter((file) =>
    file.requires_confirmation ||
    file.is_duplicate ||
    file.size > 1024 * 1024 * 1024
  ).length;
  const clutterRatio = files.length ? Math.min(1, clutterItems / files.length) : 0;
  const diskUsageRatio = scopedDiskTotal > 0 ? Math.min(1, scopedTotalSize / scopedDiskTotal) : 0;
  const scopeLabel = selectedFolders.length
    ? selectedFolders.length === 1
      ? selectedFolders[0]
      : `${selectedFolders.length} ${t("foldersSelected")}`
    : t("userSpaceHint");
  const metrics = [
    { label: t("files"), value: files.length.toLocaleString(), tone: "blue" },
    { label: t("clutterRatio"), value: percent(clutterRatio), tone: "red" }
  ];
  const analysedSize = splitDisplaySize(formatBytes(scopedTotalSize));

  return (
    <div className="scanner-stage scanner-demo-stage page-enter">
      <section className="scanner-demo-radar-wrap">
        <div
          className={`radar-chart ${isScanning ? "is-running scanner-glow" : ""}`}
          style={{ "--scan-percent": `${Math.round(diskUsageRatio * 100)}%` } as CSSProperties}
        >
          <div className="radar-inner">
              {isScanning ? (
                <div className="scanner-pulse-state">
                  <span>{t("scanning")}...</span>
                </div>
              ) : (
                <>
                  <span className="scanner-kicker">Total Analysed</span>
                  <strong className="scanner-total">
                    {analysedSize.value}
                    <span>{analysedSize.unit}</span>
                  </strong>
                  <div className="scanner-ready-pill">
                    <i />
                    <span>{percent(diskUsageRatio)}</span>
                  </div>
                </>
              )}
          </div>
        </div>
      </section>

      <section className="metric-strip scanner-demo-metrics">
        {metrics.map((metric) => (
          <div className={`metric-card ${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </section>

      <section className="scanner-actions scanner-demo-actions">
        <button className="glass-button scanner-demo-primary" onClick={scanCommon} disabled={isScanning}>
          <RefreshCw size={18} />
          <span>{isScanning ? t("scanning") : t("scanCommon")}</span>
        </button>
        {isScanning ? (
          <button className="glass-button scanner-demo-secondary" onClick={cancelScan}>
            <X size={18} />
            <span>{t("cancelScan")}</span>
          </button>
        ) : (
          <button className="glass-button scanner-demo-secondary" onClick={chooseFolders}>
            <FolderSearch size={18} />
            <span>{t("chooseFolders")}</span>
          </button>
        )}
      </section>

      <p className="scanner-scope-text">{scopeLabel}</p>
      <p className="scanner-scope-text scanner-detail-text">
        {isScanning && scanProgress
          ? t("scanProgressLine")
              .replace("{files}", scanProgress.scannedFiles.toLocaleString())
              .replace("{skipped}", scanProgress.skipped.toLocaleString())
              .replace("{path}", compactPath(scanProgress.currentPath))
          : t("diskUsageInScope").replace("{size}", formatBytes(scopedTotalSize)).replace("{disk}", formatBytes(scopedDiskTotal))}
      </p>
    </div>
  );
}

function HubView({
  files,
  setView,
  t
}: {
  files: FileRecord[];
  setView: (view: View) => void;
  t: Translator;
}) {
  const [sortedIds, setSortedIds] = useState<Set<string>>(new Set());
  const [isSorting, setIsSorting] = useState(false);
  const actionableFiles = files.filter((file) =>
    file.suggested_action !== "Keep" ||
    file.requires_confirmation ||
    file.context === "Project Folder"
  );
  const visibleFiles = (actionableFiles.length ? actionableFiles : files).slice(0, 80);
  const sortedFiles = visibleFiles.filter((file) => sortedIds.has(file.id));
  const pendingFiles = visibleFiles.filter((file) => !sortedIds.has(file.id));
  const buckets = [
    { key: "CoreAssets", label: t("coreAssets"), description: t("coreAssetsDesc"), tone: "blue" },
    { key: "QuietArchive", label: t("archiveBox"), description: t("archiveBoxDesc"), tone: "purple" },
    { key: "CleanupLane", label: t("cleanupLane"), description: t("cleanupLaneDesc"), tone: "slate" },
    { key: "PrivacyVault", label: t("privacyVault"), description: t("privacyVaultDesc"), tone: "red" }
  ];

  useEffect(() => {
    setSortedIds(new Set());
  }, [files]);

  function fileBucket(file: FileRecord) {
    if (file.risk_level === "Sensitive") return "PrivacyVault";
    return file.dispatch_zone ?? "CoreAssets";
  }

  function runDispatch() {
    if (isSorting || sortedIds.size === visibleFiles.length) {
      setView("preview");
      return;
    }
    setIsSorting(true);
    visibleFiles.forEach((file, index) => {
      window.setTimeout(() => {
        setSortedIds((current) => new Set(current).add(file.id));
        if (index === visibleFiles.length - 1) setIsSorting(false);
      }, Math.min(index * 24, 640));
    });
  }

  return (
    <div className="hub-layout page-enter">
      <section className="glass-panel hub-inbox">
        <div className="hub-panel-head">
          <h2>{t("inboxStack")}</h2>
          <span>{pendingFiles.length} {t("items")}</span>
        </div>
        <div className="hub-inbox-list">
          {pendingFiles.length ? pendingFiles.map((file, index) => (
            <FileCard key={file.id} file={file} index={index} t={t} compact />
          )) : (
            <div className="hub-empty">
              <Check size={24} />
              <span>{t("dispatchClear")}</span>
            </div>
          )}
        </div>
        <button className="hub-dispatch-button" onClick={runDispatch} disabled={isSorting}>
          {isSorting ? t("dispatching") : sortedIds.size === visibleFiles.length ? t("openPreview") : t("runDispatch")}
        </button>
      </section>

      <section className="hub-target-grid">
        {buckets.map((bucket) => {
          const bucketFiles = sortedFiles.filter((file) => fileBucket(file) === bucket.key);
          return (
            <div className={`glass-panel target-bucket ${bucket.tone} ${bucketFiles.length ? "has-files" : ""}`} key={bucket.key}>
              <div className="bucket-head">
                <div>
                  <h3>{bucket.label}</h3>
                  <small>{bucket.description}</small>
                </div>
                <span>{bucketFiles.length}</span>
              </div>
              <div className="bucket-dropzone">
                {bucketFiles.length ? bucketFiles.map((file) => (
                  <button className="bucket-file item-pop" key={file.id} onClick={() => setView("preview")}>
                    <File size={15} />
                    <span>{file.name}</span>
                  </button>
                )) : (
                  <span>{t("waitingFlow")}</span>
                )}
              </div>
            </div>
          );
        })}
      </section>
    </div>
  );
}

function VaultView({
  page,
  selectedFile,
  query,
  setQuery,
  setSelectedFileId,
  isLoading,
  onLoadMore,
  t
}: {
  page: FileQueryResult;
  selectedFile?: FileRecord;
  query: FileQuery;
  setQuery: (query: FileQuery) => void;
  setSelectedFileId: (id: string) => void;
  isLoading: boolean;
  onLoadMore: () => void;
  t: Translator;
}) {
  const filters = [
    {
      key: "all",
      label: t("libraryAllFiles"),
      description: t("libraryAllFilesDesc"),
      query: { purpose: "All", lifecycle: "All", riskLevel: "All", onlyNeedsConfirmation: false }
    },
    {
      key: "active",
      label: t("libraryActiveFiles"),
      description: t("libraryActiveFilesDesc"),
      query: { purpose: "All", lifecycle: "Active", riskLevel: "All", onlyNeedsConfirmation: false }
    },
    {
      key: "archive",
      label: t("libraryArchiveFiles"),
      description: t("libraryArchiveFilesDesc"),
      query: { purpose: "All", lifecycle: "Archive", riskLevel: "All", onlyNeedsConfirmation: false }
    },
    {
      key: "review",
      label: t("libraryReviewFiles"),
      description: t("libraryReviewFilesDesc"),
      query: { purpose: "All", lifecycle: "All", riskLevel: "All", onlyNeedsConfirmation: true }
    }
  ];
  const activeFilterKey = query.onlyNeedsConfirmation
    ? "review"
    : query.lifecycle === "Active"
      ? "active"
      : query.lifecycle === "Archive"
        ? "archive"
        : "all";
  const visibleFiles = page.files;
  const remainingCount = Math.max(0, page.total - visibleFiles.length);

  return (
    <div className="vault-layout page-enter">
      <div className="vault-chip-row">
        {filters.map((filter) => (
          <button
            key={filter.label}
            className={activeFilterKey === filter.key ? "active" : ""}
            onClick={() => setQuery({ ...filter.query, search: "" } as FileQuery)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="vault-filter-guide">
        {filters.map((filter) => (
          <span className={activeFilterKey === filter.key ? "active" : ""} key={`${filter.key}-description`}>
            <strong>{filter.label}</strong>
            {filter.description}
          </span>
        ))}
      </div>
      <p className="vault-helper">{t("libraryIntro")}</p>
      <div className="vault-count-line">
        <span>{t("libraryShowing").replace("{visible}", String(visibleFiles.length)).replace("{total}", String(page.total))}</span>
        {isLoading && <em>{t("loading")}</em>}
      </div>
      <section className="vault-grid">
        {visibleFiles.map((file) => (
          <button
            key={file.id}
            className={`asset-card glass-panel ${selectedFile?.id === file.id ? "selected" : ""}`}
            onClick={() => setSelectedFileId(file.id)}
          >
            <div className={`asset-icon ${file.risk_level === "Sensitive" ? "red" : file.lifecycle === "Archive" ? "purple" : "blue"}`}>
              <File size={24} />
            </div>
            <h3>{file.name}</h3>
            <div className="asset-meta">
              <span>{file.lifecycle}</span>
              <strong>{formatBytes(file.size)}</strong>
            </div>
            <small>{file.purpose}</small>
          </button>
        ))}
      </section>
      {remainingCount > 0 && (
        <button className="glass-button vault-load-more" onClick={onLoadMore} disabled={isLoading}>
          <Plus size={16} />
          {t("loadMoreFiles").replace("{count}", String(Math.min(page.limit, remainingCount)))}
        </button>
      )}
    </div>
  );
}

function TimelineView({
  previews,
  selectedIds,
  setSelectedIds,
  onRenamePreview,
  executeSelected,
  t
}: {
  previews: OperationPreview[];
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  onRenamePreview: (id: string, name: string) => void;
  executeSelected: () => Promise<void>;
  t: Translator;
}) {
  function toggle(id: string) {
    const preview = previews.find((item) => item.id === id);
    if (!preview || preview.is_executable === false) return;
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  }
  const groups = groupOperationPreviews(previews, t);
  const executableCount = previews.filter((preview) => preview.is_executable !== false).length;
  const blockedCount = previews.length - executableCount;

  return (
    <div className="timeline-layout page-enter">
      <section className="glass-panel preview-panel">
        <div className="section-title action-title">
          <div>
            <h2>{t("suggestedPlan")}</h2>
            <p>{t("previewBeforeExecute")}</p>
          </div>
          <button className="glass-button primary" onClick={executeSelected} disabled={!selectedIds.size}>
            <Play size={16} />
            <span>{t("executeSelected")} / {selectedIds.size}</span>
          </button>
        </div>
        <div className="preview-summary-strip">
          <span>{t("previewMainFolders")}: <strong>{groups.length}</strong></span>
          <span>{t("executableItems")}: <strong>{executableCount}</strong></span>
          <span>{t("blockedItems")}: <strong>{blockedCount}</strong></span>
        </div>
        {!previews.length ? (
          <div className="empty-state">{t("noOperations")}</div>
        ) : (
          <div className="preview-folder-grid">
            {groups.map((group) => {
              const executable = group.items.filter((item) => item.is_executable !== false);
              const allSelected = executable.length > 0 && executable.every((item) => selectedIds.has(item.id));
              return (
                <section className="preview-folder-card preview-main-folder-card" key={group.key}>
                  <label className="preview-folder-head">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={() => {
                        const next = new Set(selectedIds);
                        const shouldSelect = !allSelected;
                        executable.forEach((item) => {
                          if (shouldSelect) next.add(item.id);
                          else next.delete(item.id);
                        });
                        setSelectedIds(next);
                      }}
                    />
                    <Folder size={20} />
                    <div>
                      <strong>{group.name}</strong>
                      <span>{group.path}</span>
                    </div>
                    <em>{group.items.length}</em>
                  </label>
                  <div className="preview-subfolder-list">
                    {group.subgroups.map((subgroup) => (
                      <section className="preview-subfolder" key={`${group.key}-${subgroup.key}`}>
                        <div className="preview-subfolder-head">
                          <Folder size={16} />
                          <div>
                            <strong>{subgroup.name}</strong>
                            <span>{subgroup.path}</span>
                          </div>
                          <em>{subgroup.items.length}</em>
                        </div>
                        <div className="preview-folder-files compact">
                          {subgroup.items.map((preview) => (
                            <div className="preview-file-row" key={preview.id}>
                              <input
                                type="checkbox"
                                disabled={preview.is_executable === false}
                                checked={selectedIds.has(preview.id)}
                                onChange={() => toggle(preview.id)}
                              />
                              <File size={15} />
                              <div>
                                <strong>{preview.old_name}</strong>
                                <span>{preview.operation_type} / {percent(preview.confidence)}</span>
                                <code className="preview-path-line" title={preview.source_path}>{preview.source_path}</code>
                                <code className="preview-path-line target" title={preview.target_path}>{preview.target_path}</code>
                                <input
                                  className="inline-name-input"
                                  value={preview.new_name}
                                  disabled={!preview.editable_new_name || preview.is_executable === false}
                                  onChange={(event) => onRenamePreview(preview.id, event.target.value)}
                                  aria-label={t("newFileName")}
                                />
                              </div>
                            </div>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function RulesView({
  rules,
  onSave,
  t
}: {
  rules: Rule[];
  onSave: (rule: Rule) => Promise<void>;
  t: Translator;
}) {
  const [name, setName] = useState("Screenshots to Inbox");
  const [field, setField] = useState("name");
  const [operator, setOperator] = useState("contains");
  const [value, setValue] = useState("screenshot");
  const [purpose, setPurpose] = useState("Temporary");
  const [lifecycle, setLifecycle] = useState("Inbox");
  const [weight, setWeight] = useState(76);

  async function submit() {
    const now = nowIso();
    await onSave({
      id: localId("rule"),
      name,
      source: "user",
      enabled: true,
      priority: 75,
      weight,
      root_operator: "AND",
      groups: [
        {
          id: localId("group"),
          operator: "AND",
          conditions: [
            {
              id: localId("cond"),
              field: field as Rule["groups"][number]["conditions"][number]["field"],
              operator: operator as Rule["groups"][number]["conditions"][number]["operator"],
              value
            }
          ]
        }
      ],
      action: {
        purpose: purpose as Rule["action"]["purpose"],
        lifecycle: lifecycle as Rule["action"]["lifecycle"],
        suggested_action: "Move",
        target_template: "00_Inbox/Screenshots",
        context: "Screenshots"
      },
      created_at: now,
      updated_at: now
    });
  }

  return (
    <div className="rules-layout page-enter">
      <section className="glass-panel rule-builder">
        <SectionTitle title={t("ruleBuilder")} body={t("customDesc")} />
        <div className="rule-sentence">
          <span>{t("whenFile")}</span>
          <strong>{field}</strong>
          <strong>{operator}</strong>
          <input value={value} onChange={(event) => setValue(event.target.value)} />
          <span>{t("thenSendTo")}</span>
          <strong>{purpose}</strong>
        </div>
        <div className="form-grid">
          <label>
            {t("ruleName")}
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            {t("field")}
            <select value={field} onChange={(event) => setField(event.target.value)}>
              {["name", "extension", "file_type", "path", "directory", "size", "modified_at", "risk_level"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            {t("operator")}
            <select value={operator} onChange={(event) => setOperator(event.target.value)}>
              {["contains", "equals", "startsWith", "endsWith", "greaterThan", "lessThan", "olderThanDays", "newerThanDays"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            {t("purpose")}
            <select value={purpose} onChange={(event) => setPurpose(event.target.value)}>
              {["Temporary", "Career", "Finance", "Study", "Project", "Personal", "Media", "Unknown"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            {t("lifecycle")}
            <select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>
              {["Inbox", "Active", "Reference", "Archive", "Disposable", "Sensitive"].map((item) => (
                <option key={item}>{item}</option>
              ))}
            </select>
          </label>
          <label>
            {t("weight")}
            <input type="number" value={weight} onChange={(event) => setWeight(Number(event.target.value))} />
          </label>
        </div>
        <button className="primary-command compact-command" onClick={submit}>
          <Plus size={17} />
          {t("saveRule")}
        </button>
      </section>

      <section className="glass-panel rules-list-panel">
        <SectionTitle title={t("strategy")} body={t("ruleLayerDesc")} />
        <div className="rule-list">
          {rules.map((rule) => (
            <div className="rule-row" key={rule.id}>
              <div>
                <strong>{rule.name}</strong>
                <span>{rule.source} / weight {rule.weight} / priority {rule.priority}</span>
              </div>
              <span className={`source ${rule.source}`}>{rule.source}</span>
              <span className={`toggle-switch ${rule.enabled ? "on" : ""}`} aria-hidden="true">
                <i />
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RestoreView({ hasNativeApi, t }: { hasNativeApi: boolean; t: Translator }) {
  const [batches, setBatches] = useState<RestoreBatch[]>([]);
  const [operationLogs, setOperationLogs] = useState<OperationLog[]>([]);
  const [selectedBatch, setSelectedBatch] = useState("");
  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [restoreStatus, setRestoreStatus] = useState("");
  const fileManager = window.fileManager;

  useEffect(() => {
    if (!fileManager) return;
    fileManager.getRestoreBatches().then((next) => {
      setBatches(next);
      setSelectedBatch(next[0]?.batch_id ?? "");
    }).catch(() => undefined);
    fileManager.getSnapshot().then((snapshot) => setOperationLogs(snapshot.operations)).catch(() => undefined);
  }, [fileManager]);

  useEffect(() => {
    if (!fileManager || !selectedBatch) {
      setPreview(null);
      return;
    }
    fileManager.getRestorePreview(selectedBatch).then(setPreview).catch(() => setPreview(null));
  }, [fileManager, selectedBatch]);

  async function restoreSelectedBatch() {
    if (!fileManager || !selectedBatch) return;
    const result = await fileManager.restoreBatch(selectedBatch);
    setRestoreStatus(`${t("restored")}: ${result.restored}, ${t("failed")}: ${result.failed}, ${t("skipped")}: ${result.skipped}`);
    const next = await fileManager.getRestoreBatches();
    setBatches(next);
    setOperationLogs((await fileManager.getSnapshot()).operations);
    setPreview(await fileManager.getRestorePreview(selectedBatch));
  }

  return (
    <div className="restore-layout page-enter">
      <section className="glass-panel restore-batches">
        <SectionTitle title={t("restoreRecords")} body={t("restoreDesc")} />
        {!batches.length ? (
          <div className="empty-state">{hasNativeApi ? t("noRestoreRecords") : t("desktopOnlySetting")}</div>
        ) : (
          <div className="operation-list">
            {batches.map((batch) => (
              <button
                className={`operation-row selectable ${selectedBatch === batch.batch_id ? "selected-row" : ""}`}
                key={batch.batch_id}
                onClick={() => setSelectedBatch(batch.batch_id)}
              >
                <RotateCcw size={16} />
                <div>
                  <strong>{batch.batch_id}</strong>
                  <span>
                    {formatDate(batch.created_at)} / {batch.restorable} {t("restorable")} / {t("expires")}: {formatDate(batch.expires_at)}
                  </span>
                </div>
              </button>
            ))}
          </div>
        )}
        <div className="restore-log-divider" />
        <SectionTitle title={t("operationHistory")} body={t("timeMachineDesc")} />
        {!operationLogs.length ? (
          <div className="empty-state compact">{t("noOperationHistory")}</div>
        ) : (
          <div className="operation-list restore-operation-log">
            {operationLogs.slice(0, 80).map((operation) => (
              <div className="operation-row" key={operation.id}>
                <RotateCcw size={16} />
                <div>
                  <strong>{operation.operation_type} / {t(operation.status)}</strong>
                  <span className="path-before" title={operation.source_path}>{operation.source_path}</span>
                  <span className="path-after" title={operation.target_path}>{operation.target_path}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="glass-panel restore-preview">
        <div className="section-title action-title">
          <div>
            <h2>{t("restorePreview")}</h2>
            <p>{t("restorePreviewDesc")}</p>
          </div>
          <button
            className="glass-button primary"
            onClick={restoreSelectedBatch}
            disabled={!preview?.items.some((item) => item.can_restore)}
          >
            <RotateCcw size={16} />
            {t("restoreBatch")}
          </button>
        </div>
        {restoreStatus && <div className="system-toast inline">{restoreStatus}</div>}
        {!preview?.items.length ? (
          <div className="empty-state compact">{t("noRestorePreview")}</div>
        ) : (
          <div className="restore-preview-list">
            {preview.items.map((item) => (
              <div className={`restore-preview-card ${item.can_restore ? "ok" : "blocked"}`} key={item.log_id}>
                <div className="restore-preview-status">
                  <span className={`status-dot ${item.can_restore ? "ok" : "blocked"}`} />
                  <strong>{item.can_restore ? t("restorable") : t("needsReview")}</strong>
                </div>
                <div className="restore-preview-body">
                  <strong>{item.new_name} {"->"} {item.old_name}</strong>
                  <div className="restore-path-pair">
                    <span title={item.current_path}>{item.current_path}</span>
                    <ChevronRight size={15} />
                    <span title={item.restore_path}>{item.restore_path}</span>
                  </div>
                  {item.blocking_reason && <small>{item.blocking_reason}</small>}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SettingsView({
  language,
  setLanguage,
  theme,
  setTheme,
  platform,
  snapshot,
  setSnapshot,
  hasNativeApi,
  closeBehavior,
  setCloseBehavior,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  platform: NodeJS.Platform | "browser";
  snapshot: AppSnapshot;
  setSnapshot: (snapshot: AppSnapshot) => void;
  hasNativeApi: boolean;
  closeBehavior: CloseBehavior;
  setCloseBehavior: (behavior: CloseBehavior) => Promise<void>;
  t: Translator;
}) {
  const [sources, setSources] = useState<SearchSource[]>(snapshot.searchSources);
  const [hotkey, setHotkey] = useState(defaultPlatformAccelerator(platform));
  const [backgroundResident, setBackgroundResident] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [folderNamingLanguage, setFolderNamingLanguageState] = useState<FolderNamingLanguage>("en");
  const [defaultScanFolders, setDefaultScanFoldersState] = useState<DefaultScanFolder[]>(["Desktop", "Downloads", "Documents"]);
  const [restoreRetentionDays, setRestoreRetentionDaysState] = useState<RestoreRetentionDays>(30);
  const [settingsStatus, setSettingsStatus] = useState("");
  const fileManager = window.fileManager;
  const platformHotkeyLabel = platform === "darwin" ? "⌘ K" : "Ctrl K";

  useEffect(() => {
    setSources(snapshot.searchSources);
  }, [snapshot.searchSources]);

  useEffect(() => {
    if (!fileManager) return;
    fileManager.getSearchHotkey().then((next) => setHotkey(platformAcceleratorForInput(next, platform))).catch(() => undefined);
    fileManager.getSearchSources().then(setSources).catch(() => undefined);
    fileManager.getBackgroundResident?.().then(setBackgroundResident).catch(() => undefined);
    fileManager.getLaunchAtLogin?.().then(setLaunchAtLogin).catch(() => undefined);
    fileManager.getFolderNamingLanguage?.().then(setFolderNamingLanguageState).catch(() => undefined);
    fileManager.getDefaultScanFolders?.().then(setDefaultScanFoldersState).catch(() => undefined);
    fileManager.getRestoreRetentionDays?.().then(setRestoreRetentionDaysState).catch(() => undefined);
  }, [fileManager, platform]);

  async function toggleSource(id: string) {
    const next = sources.map((source) => source.id === id ? { ...source, enabled: !source.enabled } : source);
    setSources(next);
    if (fileManager) {
      const saved = await fileManager.updateSearchSources(next);
      setSources(saved);
      setSnapshot(await fileManager.getSnapshot());
    }
  }

  async function saveHotkey() {
    if (!fileManager) {
      setSettingsStatus(t("desktopOnlySetting"));
      return;
    }
    const result = await fileManager.setSearchHotkey(acceleratorForElectron(hotkey));
    setSettingsStatus(result.ok ? t("hotkeySaved") : t("hotkeyConflict"));
    setHotkey(platformAcceleratorForInput(result.hotkey, platform));
  }

  async function rebuildIndex() {
    if (!fileManager) {
      setSettingsStatus(t("desktopOnlySetting"));
      return;
    }
    await fileManager.rebuildSearchIndex();
    setSnapshot(await fileManager.getSnapshot());
    setSettingsStatus(t("indexRebuilt"));
  }

  async function toggleBackgroundResident() {
    if (!fileManager?.setBackgroundResident) {
      setSettingsStatus(t("desktopOnlySetting"));
      return;
    }
    const next = await fileManager.setBackgroundResident(!backgroundResident);
    setBackgroundResident(next);
    setSettingsStatus(t("settingSaved"));
  }

  async function toggleLaunchAtLogin() {
    if (!fileManager?.setLaunchAtLogin) {
      setSettingsStatus(t("desktopOnlySetting"));
      return;
    }
    const next = await fileManager.setLaunchAtLogin(!launchAtLogin);
    setLaunchAtLogin(next);
    setSettingsStatus(t("settingSaved"));
  }

  async function updateFolderNamingLanguage(next: FolderNamingLanguage) {
    setFolderNamingLanguageState(next);
    if (!fileManager?.setFolderNamingLanguage) {
      setSettingsStatus(t("desktopOnlySetting"));
      return;
    }
    const saved = await fileManager.setFolderNamingLanguage(next);
    setFolderNamingLanguageState(saved);
    await fileManager.reapplyRules();
    setSnapshot(await fileManager.getSnapshot());
    setSettingsStatus(t("settingSaved"));
  }

  async function updateCloseBehavior(next: CloseBehavior) {
    await setCloseBehavior(next);
    setSettingsStatus(t("settingSaved"));
  }

  async function toggleDefaultScanFolder(folder: DefaultScanFolder) {
    const next = defaultScanFolders.includes(folder)
      ? defaultScanFolders.filter((item) => item !== folder)
      : [...defaultScanFolders, folder];
    const normalized = next.length ? next : [folder];
    setDefaultScanFoldersState(normalized);
    if (!fileManager?.setDefaultScanFolders) {
      setSettingsStatus(t("desktopOnlySetting"));
      return;
    }
    setDefaultScanFoldersState(await fileManager.setDefaultScanFolders(normalized));
    setSettingsStatus(t("settingSaved"));
  }

  async function updateRestoreRetentionDays(days: RestoreRetentionDays) {
    setRestoreRetentionDaysState(days);
    if (!fileManager?.setRestoreRetentionDays) {
      setSettingsStatus(t("desktopOnlySetting"));
      return;
    }
    setRestoreRetentionDaysState(await fileManager.setRestoreRetentionDays(days));
    setSettingsStatus(t("settingSaved"));
  }

  return (
    <div className="settings-layout page-enter">
      <section className="glass-panel settings-panel">
        <SectionTitle title={t("settings")} body={t("settingsDesc")} />
        <div className="setting-row">
          <div>
            <strong>{t("language")}</strong>
            <span>{t("languageDesc")}</span>
          </div>
          <div className="segmented compact">
            <button className={language === "zh" ? "active" : ""} onClick={() => setLanguage("zh")}>
              中文
            </button>
            <button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>
              English
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("appearance")}</strong>
            <span>{t("appearanceDesc")}</span>
          </div>
          <div className="segmented compact tri">
            <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>
              {t("lightTheme")}
            </button>
            <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>
              {t("darkTheme")}
            </button>
            <button className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")}>
              {t("systemTheme")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("folderNaming")}</strong>
            <span>{t("folderNamingDesc")}</span>
          </div>
          <div className="segmented compact">
            <button className={folderNamingLanguage === "en" ? "active" : ""} onClick={() => void updateFolderNamingLanguage("en")}>
              Career
            </button>
            <button className={folderNamingLanguage === "zh" ? "active" : ""} onClick={() => void updateFolderNamingLanguage("zh")}>
              {t("chineseFolderNames")}
            </button>
          </div>
        </div>
        <div className="setting-row vertical">
          <div>
            <strong>{t("defaultScanFolders")}</strong>
            <span>{t("defaultScanFoldersDesc")}</span>
          </div>
          <div className="pill-check-grid">
            {(["Desktop", "Downloads", "Documents"] as DefaultScanFolder[]).map((folder) => (
              <button
                className={defaultScanFolders.includes(folder) ? "active" : ""}
                key={folder}
                onClick={() => void toggleDefaultScanFolder(folder)}
              >
                {folder}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("closeBehavior")}</strong>
            <span>{t("closeBehaviorDesc")}</span>
          </div>
          <div className="segmented compact tri">
            <button className={closeBehavior === "ask" ? "active" : ""} onClick={() => void updateCloseBehavior("ask")}>
              {t("askEveryTime")}
            </button>
            <button className={closeBehavior === "minimize" ? "active" : ""} onClick={() => void updateCloseBehavior("minimize")}>
              {t("minimize")}
            </button>
            <button className={closeBehavior === "quit" ? "active" : ""} onClick={() => void updateCloseBehavior("quit")}>
              {t("quitApp")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("searchHotkey")}</strong>
            <span>{t("searchHotkeyDesc")} <b className="platform-hotkey">{platformHotkeyLabel}</b></span>
          </div>
          <div className="inline-setting-control">
            <input value={hotkey} onChange={(event) => setHotkey(event.target.value)} />
            <button className="glass-button" onClick={saveHotkey}>{t("save")}</button>
          </div>
        </div>
        <div className="setting-row vertical">
          <div>
            <strong>{t("searchSources")}</strong>
            <span>{t("searchSourcesDesc")}</span>
          </div>
          <div className="source-toggle-list">
            {(sources.length ? sources : demoSnapshot.searchSources).map((source) => (
              <label className="source-toggle" key={source.id}>
                <input type="checkbox" checked={source.enabled} onChange={() => toggleSource(source.id)} />
                <div>
                  <strong>{source.label}</strong>
                  <span>{source.path}</span>
                </div>
                {source.is_stale && <em>{t("staleIndex")}</em>}
              </label>
            ))}
          </div>
          <button className="glass-button" onClick={rebuildIndex}>
            <RefreshCw size={16} />
            {t("rebuildIndex")}
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("backgroundResident")}</strong>
            <span>{t("backgroundResidentDesc")}</span>
          </div>
          <button className={`switch-control ${backgroundResident ? "on" : ""}`} onClick={toggleBackgroundResident}>
            <i />
            <span>{backgroundResident ? t("enabled") : t("disabled")}</span>
          </button>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("launchAtLogin")}</strong>
            <span>{t("launchAtLoginDesc")}</span>
          </div>
          <button className={`switch-control ${launchAtLogin ? "on" : ""}`} onClick={toggleLaunchAtLogin}>
            <i />
            <span>{launchAtLogin ? t("enabled") : t("disabled")}</span>
          </button>
        </div>
        <details className="advanced-settings">
          <summary>{t("advancedSettings")}</summary>
          <div className="setting-row">
            <div>
              <strong>{t("excludedDirs")}</strong>
              <span>node_modules, .git, AppData, Library, System32</span>
            </div>
          </div>
          <div className="setting-row">
            <div>
              <strong>{t("logRetention")}</strong>
              <span>{t("logRetentionDesc")}</span>
            </div>
            <div className="segmented compact quad">
              {([15, 30, 60, 90] as RestoreRetentionDays[]).map((days) => (
                <button
                  className={restoreRetentionDays === days ? "active" : ""}
                  key={days}
                  onClick={() => void updateRestoreRetentionDays(days)}
                >
                  {days} {t("days")}
                </button>
              ))}
            </div>
          </div>
        </details>
        {settingsStatus && <div className="system-toast inline">{settingsStatus}</div>}
        <div className="setting-row">
          <div>
            <strong>{t("localOnly")}</strong>
            <span>{t("privacyLine")}</span>
          </div>
          <ShieldCheck size={19} />
        </div>
      </section>
    </div>
  );
}

function CommandModal({
  inputRef,
  files,
  setView,
  setSelectedFileId,
  onClose,
  platform,
  t,
  standalone = false
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  files: FileRecord[];
  setView: (view: View) => void;
  setSelectedFileId: (id: string) => void;
  onClose: () => void;
  platform: NodeJS.Platform | "browser";
  t: Translator;
  standalone?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [nativeResults, setNativeResults] = useState<SearchResult[]>([]);
  const [nativeQueryState, setNativeQueryState] = useState<{
    query: string;
    status: "idle" | "pending" | "done" | "failed";
  }>({ query: "", status: "idle" });
  const [activeIndex, setActiveIndex] = useState(0);
  const fileManager = window.fileManager;
  const hasNativeApi = typeof fileManager !== "undefined";
  void setView;
  void setSelectedFileId;
  const trimmedSearch = search.trim();
  const nativeFinishedForQuery =
    nativeQueryState.query === trimmedSearch &&
    (nativeQueryState.status === "done" || nativeQueryState.status === "failed");
  const currentNativeResults =
    nativeQueryState.query === trimmedSearch && nativeQueryState.status === "done" ? nativeResults : [];
  const shouldUseSnapshotFallback =
    trimmedSearch.length > 0 &&
    (!hasNativeApi || (nativeFinishedForQuery && (nativeQueryState.status === "failed" || nativeResults.length === 0)));
  const fallbackResults = useMemo(
    () => (shouldUseSnapshotFallback ? findSearchSnapshotMatches(files, trimmedSearch, 12) : []),
    [files, shouldUseSnapshotFallback, trimmedSearch]
  );
  const results = useMemo(
    () => (trimmedSearch ? mergeSearchResults(hasNativeApi ? currentNativeResults : [], fallbackResults, 12) : []),
    [currentNativeResults, fallbackResults, hasNativeApi, trimmedSearch]
  );
  const showResults = trimmedSearch.length > 0 && results.length > 0;
  const locateKey = platform === "darwin" ? "⌥↵" : "Alt↵";

  useEffect(() => {
    if (!fileManager) return;
    if (!trimmedSearch) {
      setNativeResults([]);
      setNativeQueryState({ query: "", status: "idle" });
      setActiveIndex(0);
      return;
    }
    setNativeQueryState({ query: trimmedSearch, status: "pending" });
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fileManager.searchQuery({ query: trimmedSearch, limit: 12 })
        .then((next) => {
          if (cancelled) return;
          setNativeResults(next);
          setNativeQueryState({ query: trimmedSearch, status: "done" });
          setActiveIndex(0);
        })
        .catch(() => {
          if (cancelled) return;
          setNativeResults([]);
          setNativeQueryState({ query: trimmedSearch, status: "failed" });
        });
    }, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileManager, trimmedSearch]);

  async function openFile(file: FileRecord) {
    if (fileManager) {
      await fileManager.openSearchResult(file.id);
    }
    onClose();
  }

  async function revealFile(file: FileRecord) {
    if (fileManager) {
      await fileManager.revealSearchResult(file.id);
    }
  }

  function clearSearch() {
    setSearch("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function getResultTone(file: FileRecord) {
    if (file.risk_level === "Sensitive") return "red";
    if (file.lifecycle === "Archive") return "purple";
    return "blue";
  }

  return (
    <div className={`command-backdrop ${standalone ? "standalone" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={`command-modal ${standalone ? "standalone-modal" : ""} ${showResults ? "rounded-24" : "rounded-36"}`}
        onKeyDown={(event) => {
          if ((event.metaKey && event.key === "Backspace") || (event.ctrlKey && event.key === "Backspace")) {
            event.preventDefault();
            clearSearch();
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, results.length - 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Enter" && results[activeIndex]) {
            event.preventDefault();
            if (event.altKey) void revealFile(results[activeIndex].file);
            else void openFile(results[activeIndex].file);
          }
          if (event.key === "Escape") onClose();
        }}
      >
        <div className={`command-search-head ${showResults ? "has-results" : ""}`}>
          <Search className="command-search-icon" size={20} strokeWidth={2.2} />
          <input
            ref={inputRef}
            value={search}
            placeholder={t("commandPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
            onClick={() => inputRef.current?.focus()}
          />
          {search && (
            <button className="command-clear-button" onClick={clearSearch} aria-label={t("clearSearch")}>
              <X size={16} strokeWidth={2.5} />
            </button>
          )}
          <kbd className="command-esc-key">ESC</kbd>
        </div>
        {showResults && (
          <div className="command-results-panel">
            <div className="command-results">
              <div className="command-section-label">{t("smartMatches")}</div>
              <div className="command-result-stack">
                {results.map(({ file }, index) => {
                  const tone = getResultTone(file);
                  const extension = file.extension ? file.extension.replace(".", "").toUpperCase() : file.file_type;
                  return (
                    <button
                      key={file.id}
                      className={`result-item-card ${index === activeIndex ? "active-row" : ""}`}
                      onClick={() => openFile(file)}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span className={`result-main-icon ${tone}`}>
                        <File size={20} strokeWidth={1.5} />
                      </span>
                      <span className="result-copy">
                        <strong><HighlightText text={file.name} highlight={trimmedSearch} /></strong>
                        <small>
                          <span>{file.directory || file.path}</span>
                          <i />
                          <em className={tone}>{file.purpose}</em>
                        </small>
                      </span>
                      <span className="result-trailing">
                        <em>{extension}</em>
                        {index === activeIndex && <ChevronRight className="command-row-chevron" size={16} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="command-action-bar">
              <span>{t("matchesFound").replace("{count}", String(results.length))}</span>
              <div>
                <span><kbd>↵</kbd>{t("openResult")}</span>
                <span><kbd>{locateKey}</kbd>{t("revealPhysical")}</span>
                <span><kbd>⇥</kbd>{t("sortingAdvice")}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function findSearchSnapshotMatches(files: FileRecord[], query: string, limit: number) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const results: SearchResult[] = [];
  for (const file of files) {
    const haystack = [
      file.name,
      file.path,
      file.directory,
      file.extension,
      file.file_type,
      file.purpose,
      file.lifecycle,
      file.context
    ].join(" ").toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    results.push({ file, score: 10, matched_text: file.name });
    if (results.length >= limit) break;
  }
  return results;
}

function mergeSearchResults(primary: SearchResult[], fallback: SearchResult[], limit: number) {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const result of [...primary, ...fallback]) {
    if (seen.has(result.file.id)) continue;
    seen.add(result.file.id);
    merged.push(result);
    if (merged.length >= limit) break;
  }
  return merged;
}

function HighlightText({ text, highlight }: { text: string; highlight: string }) {
  const value = highlight.trim();
  if (!value) return <>{text}</>;
  const escaped = value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const matcher = new RegExp(`(${escaped})`, "ig");
  return (
    <>
      {text.split(matcher).map((part, index) => (
        part.toLowerCase() === value.toLowerCase()
          ? <mark className="highlight-mark" key={`${part}-${index}`}>{part}</mark>
          : <span key={`${part}-${index}`}>{part}</span>
      ))}
    </>
  );
}

function SectionTitle({ title, body }: { title: string; body: string }) {
  return (
    <div className="section-title">
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
    </div>
  );
}

function FileCard({ file, index, t, compact = false }: { file: FileRecord; index: number; t: Translator; compact?: boolean }) {
  return (
    <div className={`stack-card ${compact ? "compact" : ""}`} style={{ "--delay": `${index * 70}ms` } as CSSProperties}>
      <div className="file-glyph">
        <File size={18} />
      </div>
      <div>
        <strong>{file.name}</strong>
        <span>{file.purpose} / {file.lifecycle}</span>
      </div>
      <RiskBadge risk={file.risk_level} t={t} />
    </div>
  );
}

function RiskBadge({ risk, t }: { risk: string; t: Translator }) {
  const label =
    risk === "Normal" ? t("normal") :
    risk === "Sensitive" ? t("sensitiveLabel") :
    risk === "System" ? t("system") :
    t("unknown");
  return <span className={`risk ${risk.toLowerCase()}`}>{label}</span>;
}

function filterFiles(files: FileRecord[], query: FileQuery): FileRecord[] {
  const search = query.search?.toLowerCase().trim();
  const filtered = files.filter((file) => {
    if (search && !`${file.name} ${file.path} ${file.context}`.toLowerCase().includes(search)) return false;
    if (query.fileType && query.fileType !== "All" && file.file_type !== query.fileType) return false;
    if (query.purpose && query.purpose !== "All" && file.purpose !== query.purpose) return false;
    if (query.lifecycle && query.lifecycle !== "All" && file.lifecycle !== query.lifecycle) return false;
    if (query.riskLevel && query.riskLevel !== "All" && file.risk_level !== query.riskLevel) return false;
    if (query.onlyNeedsConfirmation && !file.requires_confirmation) return false;
    return true;
  });

  const sortBy = query.sortBy ?? "modified_at";
  const direction = query.sortDirection === "asc" ? 1 : -1;
  return [...filtered].sort((a, b) => {
    const left = a[sortBy];
    const right = b[sortBy];
    if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
    return String(left).localeCompare(String(right)) * direction;
  });
}

function splitDisplaySize(label: string) {
  const [value, ...unitParts] = label.split(" ");
  return {
    value: value || label,
    unit: unitParts.join(" ")
  };
}

function compactPath(value: string | null | undefined, maxLength = 42) {
  if (!value) return "-";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(8, Math.floor(maxLength * 0.45)))}...${value.slice(-Math.max(8, Math.floor(maxLength * 0.35)))}`;
}

function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function groupOperationPreviews(previews: OperationPreview[], t: Translator) {
  const groups = new Map<string, { path: string; items: OperationPreview[]; subgroups: Map<string, { path: string; items: OperationPreview[] }> }>();
  for (const preview of previews) {
    const directory = pathDirLike(preview.target_path);
    const relativeParts = relativeZenCanvasParts(directory);
    const firstSegment = relativeParts[0] ?? folderNameLike(directory);
    const mainKey = canonicalPreviewMainKey(firstSegment);
    const subgroupParts = isCanonicalPreviewMain(firstSegment) ? relativeParts.slice(1) : relativeParts;
    const subgroupKey = subgroupParts.length ? subgroupParts.join("/") : "__root__";
    const mainPath = `ZenCanvas/${mainKey}`;
    const subgroupPath = subgroupKey === "__root__" ? directory : `ZenCanvas/${mainKey}/${subgroupKey}`;
    const group = groups.get(mainKey) ?? {
      path: mainPath,
      items: [],
      subgroups: new Map<string, { path: string; items: OperationPreview[] }>()
    };
    group.items.push(preview);
    const subgroup = group.subgroups.get(subgroupKey) ?? { path: subgroupPath, items: [] };
    subgroup.items.push(preview);
    group.subgroups.set(subgroupKey, subgroup);
    groups.set(mainKey, group);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    path: group.path,
    name: previewMainFolderLabel(key, t),
    items: group.items,
    subgroups: [...group.subgroups.entries()].map(([subKey, subgroup]) => ({
      key: subKey,
      path: subgroup.path,
      name: subKey === "__root__" ? t("previewRootFiles") : prettyFolderName(subKey),
      items: subgroup.items
    }))
  }));
}

function relativeZenCanvasParts(directory: string): string[] {
  const parts = directory.replace(/\\/g, "/").split("/").filter(Boolean);
  const zenIndex = parts.findIndex((part) => part.toLowerCase() === "zencanvas");
  if (zenIndex >= 0) return parts.slice(zenIndex + 1);
  return [folderNameLike(directory)];
}

function canonicalPreviewMainKey(segment: string): string {
  if (isCanonicalPreviewMain(segment)) return segment;
  const normalized = segment.toLowerCase().replace(/^\d+_/, "");
  if (["career", "finance", "study", "work", "personal", "media", "project", "projects", "identity"].includes(normalized)) {
    return "20_Areas";
  }
  if (normalized.includes("archive") || normalized.includes("reference")) return "40_Archive";
  if (
    normalized.includes("temporary") ||
    normalized.includes("temp") ||
    normalized.includes("installer") ||
    normalized.includes("download") ||
    normalized.includes("screenshot")
  ) {
    return "90_Temporary";
  }
  if (normalized.includes("inbox")) return "00_Inbox";
  return "20_Areas";
}

function isCanonicalPreviewMain(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return normalized.startsWith("00_") || normalized.startsWith("20_") || normalized.startsWith("40_") || normalized.startsWith("90_");
}

function previewMainFolderLabel(key: string, t: Translator): string {
  const normalized = key.toLowerCase();
  if (normalized.startsWith("00_") || normalized.includes("inbox")) return t("previewInboxFolder");
  if (normalized.startsWith("20_") || normalized.includes("areas")) return t("previewAreasFolder");
  if (normalized.startsWith("40_") || normalized.includes("archive")) return t("previewArchiveFolder");
  if (normalized.startsWith("90_") || normalized.includes("temporary")) return t("previewTemporaryFolder");
  return prettyFolderName(key);
}

function prettyFolderName(value: string): string {
  return value
    .split("/")
    .map((part) => part.replace(/^\d+_/, "").replace(/[_-]+/g, " "))
    .join(" / ");
}

function defaultPlatformAccelerator(platform: NodeJS.Platform | "browser"): string {
  return platform === "darwin" ? "Command+K" : "Control+K";
}

function platformAcceleratorForInput(accelerator: string, platform: NodeJS.Platform | "browser"): string {
  return accelerator.replace(/CommandOrControl/gi, platform === "darwin" ? "Command" : "Control");
}

function acceleratorForElectron(accelerator: string): string {
  return accelerator.trim().replace(/^Ctrl\+/i, "Control+");
}

function createOperationPreviews(files: FileRecord[]): OperationPreview[] {
  return files
    .filter((file) => ["Move", "Rename", "MoveAndRename", "Archive"].includes(file.suggested_action))
    .filter((file) => file.risk_level !== "Sensitive")
    .map((file) => {
      const newName = file.suggested_name || file.name;
      const targetDirectory =
        file.suggested_target_path || (file.suggested_action === "Rename" ? file.directory : "");
      const targetPath = targetDirectory ? joinPathLike(targetDirectory, newName) : file.path;
      const isMove = Boolean(targetDirectory) && normalizePathLike(targetDirectory) !== normalizePathLike(file.directory);
      const isRename = newName !== file.name;
      const operationType: OperationPreview["operation_type"] =
        isMove && isRename ? "move_rename" : isMove ? "move" : "rename";
      const requiresConfirmation = file.requires_confirmation || file.confidence < 0.7;
      return {
        id: localId("op"),
        fileId: file.id,
        operation_type: operationType,
        source_path: file.path,
        target_path: targetPath,
        old_name: file.name,
        new_name: newName,
        status: "pending" as const,
        risk_level: file.risk_level,
        confidence: file.confidence,
        requires_confirmation: requiresConfirmation,
        reason: file.classification_reason,
        selected_by_default: !requiresConfirmation,
        is_executable: true,
        editable_new_name: true
      };
    })
    .filter((preview) => normalizePathLike(preview.source_path) !== normalizePathLike(preview.target_path));
}

function applyPreviewNameOverride(preview: OperationPreview, name?: string): OperationPreview {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === preview.new_name) return preview;
  const directory = pathDirLike(preview.target_path);
  return {
    ...preview,
    new_name: trimmed,
    target_path: joinPathLike(directory, trimmed),
    operation_type: normalizePathLike(directory) === normalizePathLike(pathDirLike(preview.source_path))
      ? "rename"
      : "move_rename"
  };
}

function createDemoFiles(): FileRecord[] {
  const now = new Date().toISOString();
  const files: Array<Partial<FileRecord> & Pick<FileRecord, "name" | "file_type" | "purpose" | "lifecycle" | "risk_level" | "suggested_action" | "confidence" | "classification_reason">> = [
    {
      name: "resume_2026.pdf",
      file_type: "Document",
      purpose: "Career",
      lifecycle: "Reference",
      risk_level: "Normal",
      suggested_action: "Move",
      confidence: 0.84,
      classification_reason: "Matched Career and resume files"
    },
    {
      name: "invoice_apple.pdf",
      file_type: "Document",
      purpose: "Finance",
      lifecycle: "Reference",
      risk_level: "Sensitive",
      suggested_action: "Review",
      confidence: 0.78,
      classification_reason: "Matched Finance and receipt files; sensitive files require manual confirmation"
    },
    {
      name: "passport_scan.jpg",
      file_type: "Image",
      purpose: "Identity",
      lifecycle: "Sensitive",
      risk_level: "Sensitive",
      suggested_action: "Review",
      confidence: 0.92,
      classification_reason: "Matched Sensitive identity documents; sensitive files require manual confirmation"
    },
    {
      name: "setup.exe",
      file_type: "Installer",
      purpose: "Installer",
      lifecycle: "Disposable",
      risk_level: "Normal",
      suggested_action: "Review",
      confidence: 0.68,
      classification_reason: "Matched Installers and setup packages"
    },
    {
      name: "UNSW_COMP9900_Final_Report.pdf",
      file_type: "Document",
      purpose: "Study",
      lifecycle: "Archive",
      risk_level: "Normal",
      suggested_action: "Move",
      confidence: 0.72,
      classification_reason: "Matched Study material and coursework"
    },
    {
      name: "Screenshot 2026-06-15 at 10.22.01.png",
      file_type: "Image",
      purpose: "Media",
      lifecycle: "Inbox",
      risk_level: "Normal",
      suggested_action: "Rename",
      confidence: 0.62,
      classification_reason: "Matched Downloads and desktop inbox"
    }
  ];

  return files.map((file, index) => {
    const directory = "C:/Users/example/Downloads";
    const path = `${directory}/${file.name}`;
    const extension = file.name.split(".").pop() ?? "";
    return {
      id: `demo_${index}`,
      name: file.name,
      path,
      directory,
      extension,
      size: (index + 1) * 2_400_000,
      file_type: file.file_type,
      purpose: file.purpose,
      lifecycle: file.lifecycle,
      context: file.context ?? file.purpose,
      risk_level: file.risk_level,
      hash: null,
      created_at: now,
      modified_at: new Date(Date.now() - index * 8 * 86_400_000).toISOString(),
      scanned_at: now,
      last_seen_at: now,
      is_hidden: false,
      is_deleted: false,
      is_duplicate: false,
      suggested_action: file.suggested_action,
      suggested_target_path:
        file.suggested_action === "Move" ? `C:/Users/example/ZenCanvas/${file.purpose}` : "",
      suggested_name:
        file.suggested_action === "Rename" ? "screenshot_20260615_001.png" : file.name,
      confidence: file.confidence,
      classification_reason: file.classification_reason,
      matched_rules: [file.classification_reason.replace("; sensitive files require manual confirmation", "")],
      requires_confirmation: file.risk_level === "Sensitive" || file.suggested_action === "Review",
      dispatch_zone:
        file.risk_level === "Sensitive"
          ? "PrivacyVault"
          : file.lifecycle === "Archive"
            ? "QuietArchive"
            : file.lifecycle === "Disposable"
              ? "CleanupLane"
              : "CoreAssets",
      recommended_folder: `C:/Users/example/Downloads/ZenCanvas/${file.purpose}`,
      dispatch_reason: `${file.purpose}/${file.lifecycle}/${file.risk_level}`,
      next_action: file.risk_level === "Sensitive" ? "Review only" : "Send to preview",
      indexed_at: now,
      source_id: "demo-source",
      is_stale: false,
      open_count: 0,
      last_opened_at: null
    };
  });
}

function createDemoRules(): Rule[] {
  const now = new Date().toISOString();
  return [
    demoRule("system_career", "Career and resume files", "system", 90, 84),
    demoRule("system_finance", "Finance and receipt files", "system", 80, 80),
    demoRule("system_identity", "Sensitive identity documents", "system", 100, 95),
    {
      ...demoRule("user_screenshots", "Screenshots to Inbox", "user", 75, 76),
      action: {
        purpose: "Temporary" as const,
        lifecycle: "Inbox" as const,
        suggested_action: "Move" as const,
        target_template: "00_Inbox/Screenshots",
        context: "Screenshots"
      }
    }
  ].map((rule) => ({ ...rule, created_at: now, updated_at: now }));
}

function demoRule(
  id: string,
  name: string,
  source: Rule["source"],
  priority: number,
  weight: number
): Rule {
  const now = new Date().toISOString();
  return {
    id,
    name,
    source,
    enabled: true,
    priority,
    weight,
    root_operator: "AND",
    groups: [
      {
        id: `${id}_group`,
        operator: "AND",
        conditions: [{ id: `${id}_cond`, field: "name", operator: "contains", value: name.split(" ")[0] }]
      }
    ],
    action: { suggested_action: "Move", target_template: "00_Inbox" },
    created_at: now,
    updated_at: now
  };
}

function joinPathLike(directory: string, name: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function pathDirLike(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function folderNameLike(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) || normalized : normalized;
}

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function fileBelongsToRoots(file: FileRecord, roots: string[]): boolean {
  const filePath = normalizePathLike(file.path);
  return roots.some((root) => {
    const normalizedRoot = normalizePathLike(root);
    return filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}/`);
  });
}

function samePathLike(left: string, right: string): boolean {
  return normalizePathLike(left) === normalizePathLike(right);
}

function sumUniqueDiskTotal(roots: AppSnapshot["scanRoots"]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const root of roots) {
    const value = Number(root.disk_total_size ?? 0);
    if (!value) continue;
    const normalized = normalizePathLike(root.path);
    const volume = normalized.match(/^[a-z]:/)?.[0] ?? normalized.split("/")[0] ?? normalized;
    if (seen.has(volume)) continue;
    seen.add(volume);
    total += value;
  }
  return total;
}

function preferredLanguage(): Language {
  if (typeof window === "undefined") return "zh";
  return window.localStorage.getItem("zc-language") === "en" || window.localStorage.getItem("fma-language") === "en"
    ? "en"
    : "zh";
}

function preferredTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem("zc-theme");
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

function prefersDarkScheme(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
}

function detectBrowserPlatform(): NodeJS.Platform | "browser" {
  if (typeof navigator === "undefined") return "browser";
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || userAgent.includes("windows")) return "win32";
  if (platform.includes("mac") || userAgent.includes("mac os")) return "darwin";
  if (platform.includes("linux") || userAgent.includes("linux")) return "linux";
  return "browser";
}

function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function localId(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}
