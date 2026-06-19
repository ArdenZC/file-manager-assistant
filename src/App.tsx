import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
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
import { tauriApi } from "./api/tauriApi";
import { CommandModal } from "./components/CommandModal";
import { ViewErrorBoundary } from "./components/ErrorBoundary";
import { AmbientMesh, CloseChoiceDialog, TitlebarTools, ZenMark } from "./components/ShellChrome";
import { makeTranslator } from "./i18n";
import { useDebounce } from "./hooks/useDebounce";
import { useScanManager } from "./hooks/useScanManager";
import { useAppStore } from "./store/useAppStore";
import { useRulesStore } from "./store/useRulesStore";
import type {
  CloseBehavior,
  DashboardStats,
  FileQueryResult,
  FileRecord,
  OperationLog,
  OperationPreview,
  Rule
} from "./types/domain";
import type { ThemeMode } from "./types/ui";
import { formatDate } from "./utils/format";
import {
  applyPreviewNameOverride,
  createOperationPreviews,
  detectBrowserPlatform,
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

const PAGE_SIZE = 50;
const MAX_LOGS = 500;

const emptyStats: DashboardStats = {
  totalFiles: 0,
  totalSize: 0,
  diskTotalSize: 0,
  diskFreeSize: 0,
  diskUsageRatio: 0,
  duplicateFiles: 0,
  largeFiles: 0,
  sensitiveFiles: 0,
  needsConfirmation: 0,
  byType: {},
  byLifecycle: {},
  lastScannedAt: null
};

const emptyPage: FileQueryResult = {
  files: [],
  total: 0,
  limit: PAGE_SIZE,
  offset: 0
};

const IS_SEARCH_MODE = new URLSearchParams(window.location.search).get("mode") === "search";

export function App() {
  const language = useAppStore((state) => state.language);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const rules = useRulesStore((state) => state.rules);
  const addRule = useRulesStore((state) => state.addRule);
  const [systemDark, setSystemDark] = useState(() => prefersDarkScheme());
  const [stats, setStats] = useState<DashboardStats>(emptyStats);
  const [libraryPage, setLibraryPage] = useState<FileQueryResult>(emptyPage);
  const [selectedFileId, setSelectedFileId] = useState("");
  const [operationLogs, setOperationLogs] = useState<OperationLog[]>([]);
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const [previewNameOverrides, setPreviewNameOverrides] = useState<Record<string, string>>({});
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isCloseChoiceOpen, setIsCloseChoiceOpen] = useState(false);
  const [closeBehavior, setCloseBehaviorState] = useState<CloseBehavior>(() => {
    const saved = window.localStorage.getItem("zc-close-behavior");
    return saved === "minimize" || saved === "quit" || saved === "ask" ? saved : "ask";
  });
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const closeBehaviorRef = useRef(closeBehavior);
  const platform = detectBrowserPlatform();
  const isWindows = platform === "win32";
  const effectiveTheme: Exclude<ThemeMode, "system"> = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const hotkeyLabel = platform === "darwin" ? "⌘ K" : "Ctrl K";
  const t = useMemo(() => makeTranslator(language), [language]);
  const showSuccess = (msg: string) => setToast({ message: msg, type: "success" });
  const showError = (msg: string) => setToast({ message: msg, type: "error" });

  const loadStats = useCallback(async () => {
    try {
      setStats(await tauriApi.getStatsSummary());
    } catch (error) {
      setStats(emptyStats);
      showError(readableError(error));
    }
  }, []);

  const loadFirstPage = useCallback(async () => {
    try {
      const page = await tauriApi.getPagedFiles(PAGE_SIZE, 0, debouncedSearchQuery || undefined);
      setLibraryPage(page);
      setSelectedFileId((current) => current || page.files[0]?.id || "");
    } catch (error) {
      setLibraryPage(emptyPage);
      showError(readableError(error));
    }
  }, [debouncedSearchQuery]);

  const { selectedFolders, isScanning, scanState, handleScan, handleChooseFolders, cancelScan } = useScanManager({
    t,
    loadStats,
    loadFirstPage,
    showSuccess,
    showError,
    clearToast: () => setToast(null)
  });

  useEffect(() => {
    document.documentElement.classList.toggle("search-window-root", IS_SEARCH_MODE);
    document.body.classList.toggle("search-window-root", IS_SEARCH_MODE);
    return () => {
      document.documentElement.classList.remove("search-window-root");
      document.body.classList.remove("search-window-root");
    };
  }, []);

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
      if (!event.key || event.key === "zc-theme") setTheme(preferredTheme());
      if (!event.key || event.key === "zc-language" || event.key === "fma-language") {
        setLanguage(preferredLanguage());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [setLanguage, setTheme]);

  useEffect(() => {
    void tauriApi.initDatabase().catch(() => undefined);
    void Promise.all([loadStats(), loadFirstPage()]);
  }, [loadFirstPage, loadStats]);

  useEffect(() => {
    closeBehaviorRef.current = closeBehavior;
  }, [closeBehavior]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandOpen(true);
      }
      if (event.key === "Escape") setIsCommandOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (isCommandOpen) window.setTimeout(() => commandInputRef.current?.focus(), 40);
  }, [isCommandOpen]);

  useEffect(() => {
    if (IS_SEARCH_MODE) {
      setTheme(preferredTheme());
      setLanguage(preferredLanguage());
      setIsCommandOpen(true);
    }
  }, [setLanguage, setTheme]);

  const files = libraryPage.files;
  const selectedFile = files.find((file) => file.id === selectedFileId) ?? files[0];
  const previews = useMemo(() => createOperationPreviews(files), [files]);
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
    window.localStorage.setItem("zc-close-behavior", next);
    setCloseBehaviorState(next);
  }

  async function saveRule(rule: Rule) {
    addRule(rule);
  }

  async function runDispatch() {
    try {
      const summary = await tauriApi.executeRulesOnInbox(rules);
      await Promise.all([loadStats(), loadFirstPage()]);
      showSuccess(`${t("success")}: ${summary.updated.toLocaleString()} / ${summary.scanned.toLocaleString()}`);
      return summary;
    } catch (error) {
      showError(readableError(error));
      throw error;
    }
  }

  async function executeSelected() {
    const operations = displayPreviews.filter((preview) =>
      selectedOperationIds.has(preview.id) && preview.is_executable !== false
    );
    if (!operations.length) return;
    try {
      const result = await tauriApi.executeMoves(operations as OperationPreview[]);
      setOperationLogs((current) => [...result.logs, ...current].slice(0, MAX_LOGS));
      setSelectedOperationIds(new Set());
      await Promise.all([loadStats(), loadFirstPage()]);
      showSuccess(t("success"));
    } catch (error) {
      showError(readableError(error));
    }
  }

  async function restoreOperationLogs(logs: OperationLog[]) {
    if (!logs.length) return;
    try {
      const result = await tauriApi.restoreMoves(logs);
      const updatedById = new Map(result.logs.map((log) => [log.id, log]));
      setOperationLogs((current) => current.map((log) => updatedById.get(log.id) ?? log));
      await Promise.all([loadStats(), loadFirstPage()]);
      showSuccess(`${t("restored")}: ${result.restored.toLocaleString()}`);
    } catch (error) {
      showError(readableError(error));
    }
  }

  async function handleWindowAction(action: "minimize" | "maximize" | "close") {
    const win = getCurrentWindow();
    if (action === "minimize") {
      await win.minimize();
    } else if (action === "maximize") {
      const isMax = await win.isMaximized();
      if (isMax) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
    } else {
      requestClose();
    }
  }

  function requestClose() {
    const behavior = closeBehaviorRef.current;
    if (behavior === "ask") {
      setIsCloseChoiceOpen(true);
      return;
    }
    if (behavior === "quit") getCurrentWindow().close();
    setIsCloseChoiceOpen(false);
  }

  async function resolveCloseChoice(action: "minimize" | "quit", remember: boolean) {
    if (remember) await setCloseBehavior(action);
    setIsCloseChoiceOpen(false);
    if (action === "quit") getCurrentWindow().close();
  }

  const activeLabel = nav.find((item) => item.id === view)?.label ?? t("spaceScan");
  const scannerLastScanLabel = stats.lastScannedAt ? formatDate(stats.lastScannedAt) : t("notScannedYet");
  const headingDescription =
    view === "scanner"
      ? `${t("lastScan")}: ${scannerLastScanLabel}`
      : stats.lastScannedAt
        ? `${t("lastScan")}: ${formatDate(stats.lastScannedAt)}`
        : t("notScannedYet");

  if (IS_SEARCH_MODE) {
    return (
      <div className="zen-app search-window">
        {isCommandOpen && (
          <CommandModal
            inputRef={commandInputRef}
            setView={setView}
            setSelectedFileId={setSelectedFileId}
            onClose={() => setIsCommandOpen(false)}
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
              <button className="traffic-dot yellow" onClick={() => handleWindowAction("minimize")} aria-label={t("minimize")} />
              <button className="traffic-dot green" onClick={() => handleWindowAction("maximize")} aria-label={t("maximize")} />
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

          {toast && (
            <div className={`system-toast system-toast--${toast.type}`}>
              {toast.message}
            </div>
          )}

          <div className="view-stage">
            <ViewErrorBoundary key={view}>
              {view === "scanner" && (
                <ScannerView
                  stats={stats}
                  files={files}
                  selectedFolders={selectedFolders}
                  isScanning={isScanning}
                  scanProgress={scanState.progress}
                  chooseFolders={handleChooseFolders}
                  scanCommon={handleScan}
                  cancelScan={cancelScan}
                  t={t}
                />
              )}
              {view === "organize" && (
                <HubView files={files} rules={rules} onRunDispatch={runDispatch} setView={setView} t={t} />
              )}
              {view === "library" && (
                <VaultView
                  page={libraryPage}
                  setPage={setLibraryPage}
                  selectedFile={selectedFile}
                  searchQuery={searchQuery}
                  setSearchQuery={setSearchQuery}
                  setSelectedFileId={setSelectedFileId}
                  onRefreshStats={loadStats}
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
              {view === "rules" && <RulesView rules={rules} onSave={saveRule} t={t} />}
              {view === "restore" && (
                <RestoreView logs={operationLogs} onRestore={restoreOperationLogs} t={t} />
              )}
              {view === "settings" && (
                <SettingsView
                  language={language}
                  setLanguage={setLanguage}
                  theme={theme}
                  setTheme={setTheme}
                  platform={platform}
                  closeBehavior={closeBehavior}
                  setCloseBehavior={setCloseBehavior}
                  t={t}
                />
              )}
            </ViewErrorBoundary>
          </div>
        </main>
      </div>

      {isCommandOpen && (
        <CommandModal
          inputRef={commandInputRef}
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
