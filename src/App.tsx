import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  Check,
  ChevronRight,
  Clock3,
  Command,
  File,
  Files,
  FolderOpen,
  FolderSearch,
  Languages,
  LayoutGrid,
  ListChecks,
  LockKeyhole,
  Minus,
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
  Sparkles,
  Square,
  Sun,
  X
} from "lucide-react";
import type {
  AppSnapshot,
  FileQuery,
  FileRecord,
  FolderScanResult,
  OperationPreview,
  RestoreBatch,
  RestorePreview,
  Rule,
  SearchResult,
  SearchSource
} from "./types/domain";
import { type Language, makeTranslator } from "./i18n";
import { formatBytes, formatDate, percent } from "./utils/format";

type View = "scanner" | "organize" | "library" | "preview" | "rules" | "restore" | "settings";
type ThemeMode = "light" | "dark";
type Translator = ReturnType<typeof makeTranslator>;

const demoFiles = createDemoFiles();
const demoSnapshot: AppSnapshot = {
  stats: {
    totalFiles: demoFiles.length,
    totalSize: demoFiles.reduce((sum, file) => sum + file.size, 0),
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

export function App() {
  const [language, setLanguageState] = useState<Language>(() => preferredLanguage());
  const [theme, setThemeState] = useState<ThemeMode>(() => preferredTheme());
  const t = useMemo(() => makeTranslator(language), [language]);
  const [view, setView] = useState<View>("scanner");
  const [snapshot, setSnapshot] = useState<AppSnapshot>(demoSnapshot);
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
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [previewNameOverrides, setPreviewNameOverrides] = useState<Record<string, string>>({});
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const fileManager = window.fileManager;
  const platform = fileManager?.platform ?? detectBrowserPlatform();
  const isWindows = platform === "win32";
  const hasNativeApi = typeof fileManager !== "undefined";

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    window.localStorage.setItem("zc-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!fileManager) return;
    fileManager.getSnapshot().then((next) => {
      if (next.files.length) {
        setSnapshot(next);
        setSelectedFileId(next.files[0]?.id ?? "");
      }
    });
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
    const unsubscribe = fileManager?.onCommandOpen?.(() => setIsCommandOpen(true));
    return () => unsubscribe?.();
  }, [fileManager]);

  useEffect(() => {
    const unsubscribe = fileManager?.onCommandHide?.(() => setIsCommandOpen(false));
    return () => unsubscribe?.();
  }, [fileManager]);

  useEffect(() => {
    if (isCommandOpen) {
      window.setTimeout(() => commandInputRef.current?.focus(), 40);
    }
  }, [isCommandOpen]);

  useEffect(() => {
    setSelectedOperationIds(
      new Set(displayPreviews.filter((preview) => preview.selected_by_default).map((preview) => preview.id))
    );
    setPreviewNameOverrides({});
  }, [snapshot.files]);

  const filteredFiles = useMemo(() => filterFiles(snapshot.files, query), [snapshot.files, query]);
  const selectedFile =
    snapshot.files.find((file) => file.id === selectedFileId) ?? filteredFiles[0] ?? snapshot.files[0];
  const previews = useMemo(() => createOperationPreviews(snapshot.files), [snapshot.files]);
  const displayPreviews = useMemo(
    () => previews.map((preview) => applyPreviewNameOverride(preview, previewNameOverrides[preview.id])),
    [previewNameOverrides, previews]
  );
  const reviewFiles = useMemo(
    () => snapshot.files.filter((file) => file.requires_confirmation).slice(0, 6),
    [snapshot.files]
  );
  const previewActionCount = displayPreviews.filter((preview) => preview.status === "pending").length;

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

  async function refreshSnapshot() {
    if (!fileManager) return;
    const next = await fileManager.getSnapshot();
    setSnapshot(next);
    setSelectedFileId(next.files[0]?.id ?? "");
  }

  async function handleScan() {
    setIsScanning(true);
    try {
      if (fileManager) {
        await fileManager.scanDefaults();
        await refreshSnapshot();
        setStatus(t("success"));
      } else {
        setSnapshot(demoSnapshot);
        setStatus(t("demoMode"));
      }
    } catch (error) {
      setStatus(readableError(error));
    } finally {
      setIsScanning(false);
    }
  }

  async function handleChooseFolders() {
    setIsScanning(true);
    try {
      if (fileManager) {
        const result: FolderScanResult = await fileManager.chooseAndScanFolders();
        if (result.canceled) {
          setStatus(t("noFolderSelected"));
          return;
        }
        setSelectedFolders(result.selectedPaths);
        const next = await fileManager.getSnapshot();
        setSnapshot(next);
        setSelectedFileId(next.files[0]?.id ?? "");
        setStatus(`${t("success")}: ${result.selectedPaths.length} / ${next.files.length}`);
      } else {
        const sampleFolders = ["C:/Users/example/Downloads", "C:/Users/example/Desktop"];
        setSelectedFolders(sampleFolders);
        setSnapshot(demoSnapshot);
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
    }
    setSelectedOperationIds(new Set());
  }

  function handleWindowAction(action: "minimize" | "maximize" | "close") {
    void fileManager?.windowControl?.(action);
  }

  const activeLabel = nav.find((item) => item.id === view)?.label ?? t("spaceScan");

  return (
    <div className="zen-app">
      <div className="ambient-layer" aria-hidden="true" />

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
              setLanguage={setLanguage}
              setTheme={setTheme}
            />
          )}
        </div>

        <div className="titlebar-center">
          <button className="spotlight-trigger" onClick={() => setIsCommandOpen(true)}>
            <Search size={15} />
            <span>{t("globalSearch")}</span>
            <kbd>
              {isWindows ? <span>Ctrl</span> : <Command size={12} />}
              <span>K</span>
            </kbd>
          </button>
        </div>

        <div className="titlebar-right">
          {!isWindows ? (
            <TitlebarTools
              language={language}
              theme={theme}
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
              <p>
                {snapshot.stats.lastScannedAt
                  ? `${t("lastScan")}: ${formatDate(snapshot.stats.lastScannedAt)}`
                  : t("demoMode")}
              </p>
            </div>
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
          </div>

          {status && <div className="system-toast">{status}</div>}

          <div className="view-stage">
            {view === "scanner" && (
              <ScannerView
                snapshot={snapshot}
                selectedFolders={selectedFolders}
                isScanning={isScanning}
                chooseFolders={handleChooseFolders}
                scanCommon={handleScan}
                setView={setView}
                t={t}
              />
            )}
            {view === "organize" && (
              <HubView
                files={snapshot.files}
                reviewFiles={reviewFiles}
                previews={displayPreviews}
                setView={setView}
                t={t}
              />
            )}
            {view === "library" && (
              <VaultView
                files={filteredFiles}
                selectedFile={selectedFile}
                query={query}
                setQuery={setQuery}
                setSelectedFileId={setSelectedFileId}
                t={t}
              />
            )}
            {view === "preview" && (
              <TimelineView
                snapshot={snapshot}
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
                snapshot={snapshot}
                setSnapshot={setSnapshot}
                hasNativeApi={hasNativeApi}
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
          t={t}
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

function TitlebarTools({
  language,
  theme,
  setLanguage,
  setTheme
}: {
  language: Language;
  theme: ThemeMode;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeMode) => void;
}) {
  return (
    <div className="titlebar-tools">
      <button className="round-tool" onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
        {theme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
      <button className="lang-toggle" onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>
        <Languages size={16} />
        <span>{language === "zh" ? "EN" : "中文"}</span>
      </button>
    </div>
  );
}

function ScannerView({
  snapshot,
  selectedFolders,
  isScanning,
  chooseFolders,
  scanCommon,
  setView,
  t
}: {
  snapshot: AppSnapshot;
  selectedFolders: string[];
  isScanning: boolean;
  chooseFolders: () => Promise<void>;
  scanCommon: () => Promise<void>;
  setView: (view: View) => void;
  t: Translator;
}) {
  const scannedRatio = Math.min(100, Math.max(12, snapshot.stats.totalFiles * 7));
  const metrics = [
    { label: t("totalFiles"), value: snapshot.stats.totalFiles.toLocaleString(), tone: "blue" },
    { label: t("totalSize"), value: formatBytes(snapshot.stats.totalSize), tone: "green" },
    { label: t("needsReview"), value: snapshot.stats.needsConfirmation.toString(), tone: "red" },
    { label: t("sensitive"), value: snapshot.stats.sensitiveFiles.toString(), tone: "purple" }
  ];

  return (
    <div className="scanner-grid page-enter">
      <section className="scanner-hero glass-panel">
        <div className="scanner-copy">
          <div className="quiet-chip">
            <ShieldCheck size={15} />
            <span>{t("primaryPromise")}</span>
          </div>
          <h2>{t("folderPickerTitle")}</h2>
          <p>{t("folderPickerSubtitle")}</p>
          <div className="hero-actions">
            <button className="primary-command" onClick={chooseFolders} disabled={isScanning}>
              <FolderSearch size={20} />
              <span>{isScanning ? t("scanning") : t("chooseFoldersLong")}</span>
            </button>
            <button className="secondary-command" onClick={scanCommon} disabled={isScanning}>
              <RefreshCw size={18} className={isScanning ? "spin" : ""} />
              <span>{t("scanCommon")}</span>
            </button>
          </div>
        </div>

        <div className={`radar-card ${isScanning ? "is-scanning" : ""}`}>
          <div className="radar-ring" style={{ "--progress": `${scannedRatio}%` } as CSSProperties}>
            <div className="radar-core">
              {isScanning ? (
                <>
                  <Radar size={36} />
                  <strong>{t("scanning")}</strong>
                </>
              ) : (
                <>
                  <span>{t("totalAnalysed")}</span>
                  <strong>{formatBytes(snapshot.stats.totalSize)}</strong>
                  <em>{t("ready")}</em>
                </>
              )}
            </div>
          </div>
        </div>
      </section>

      <section className="metric-strip">
        {metrics.map((metric) => (
          <div className={`metric-card ${metric.tone}`} key={metric.label}>
            <span>{metric.label}</span>
            <strong>{metric.value}</strong>
          </div>
        ))}
      </section>

      <section className="glass-panel tutorial-card">
        <SectionTitle title={t("guidedStart")} body={t("guidedStartDesc")} />
        <div className="tutorial-steps">
          <FlowStep index="01" title={t("stepChoose")} body={t("stepChooseDesc")} />
          <FlowStep index="02" title={t("stepScan")} body={t("stepScanDesc")} />
          <FlowStep index="03" title={t("stepReview")} body={t("stepReviewDesc")} />
        </div>
      </section>

      <section className="glass-panel folders-card">
        <SectionTitle title={t("selectedFolders")} body={t("selectedFoldersDesc")} />
        <div className="folder-list">
          {(selectedFolders.length ? selectedFolders : [t("noFolderSelected")]).map((folder) => (
            <div className="folder-pill" key={folder}>
              <FolderOpen size={15} />
              <span>{folder}</span>
            </div>
          ))}
        </div>
      </section>

      <section className="glass-panel strategy-card">
        <SectionTitle title={t("strategy")} body={t("safeModeDesc")} />
        <div className="segmented">
          <button className="active">{t("builtInRules")}</button>
          <button onClick={() => setView("rules")}>{t("customRules")}</button>
        </div>
        <p>{t("builtInDesc")}</p>
        <p>{t("customDesc")}</p>
      </section>
    </div>
  );
}

function HubView({
  files,
  reviewFiles,
  previews,
  setView,
  t
}: {
  files: FileRecord[];
  reviewFiles: FileRecord[];
  previews: OperationPreview[];
  setView: (view: View) => void;
  t: Translator;
}) {
  const inboxFiles = files.slice(0, 5);
  const categories = [
    { label: t("coreAssets"), value: files.filter((file) => (file.dispatch_zone ?? "CoreAssets") === "CoreAssets").length },
    { label: t("archiveBox"), value: files.filter((file) => file.dispatch_zone === "QuietArchive").length },
    { label: t("privacyVault"), value: files.filter((file) => file.dispatch_zone === "PrivacyVault" || file.risk_level === "Sensitive").length },
    { label: t("cleanupLane"), value: files.filter((file) => file.dispatch_zone === "CleanupLane").length }
  ];

  return (
    <div className="hub-layout page-enter">
      <section className="glass-panel inbox-column">
        <SectionTitle title={t("inboxStack")} body={t("inboxStackDesc")} />
        <div className="file-stack">
          {inboxFiles.map((file, index) => (
            <FileCard key={file.id} file={file} index={index} t={t} />
          ))}
        </div>
      </section>

      <section className="dispatch-core glass-panel">
        <div className="dispatch-orbit">
          <Sparkles size={34} />
          <strong>{previews.length}</strong>
          <span>{t("suggestedPlan")}</span>
        </div>
        <p>{t("dispatchDesc")}</p>
        <div className="dispatch-actions">
          <button className="primary-command" onClick={() => setView("preview")}>
            <ListChecks size={18} />
            <span>{t("openPreview")}</span>
          </button>
          <button className="secondary-command" onClick={() => setView("rules")}>
            <SlidersHorizontal size={18} />
            <span>{t("openRuleBuilder")}</span>
          </button>
        </div>
      </section>

      <section className="glass-panel target-column">
        <SectionTitle title={t("targetBoxes")} body={t("targetBoxesDesc")} />
        <div className="target-list">
          {categories.map((category) => (
            <div className="target-box" key={category.label}>
              <span>{category.label}</span>
              <strong>{category.value}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="glass-panel review-dock">
        <SectionTitle title={t("reviewQueue")} body={t("confidenceHint")} />
        {reviewFiles.length ? (
          <div className="review-list">
            {reviewFiles.map((file) => (
              <button className="review-row" key={file.id} onClick={() => setView("library")}>
                <span>{file.name}</span>
                <RiskBadge risk={file.risk_level} t={t} />
              </button>
            ))}
          </div>
        ) : (
          <div className="empty-state compact">{t("reviewQueueEmpty")}</div>
        )}
      </section>
    </div>
  );
}

function VaultView({
  files,
  selectedFile,
  query,
  setQuery,
  setSelectedFileId,
  t
}: {
  files: FileRecord[];
  selectedFile?: FileRecord;
  query: FileQuery;
  setQuery: (query: FileQuery) => void;
  setSelectedFileId: (id: string) => void;
  t: Translator;
}) {
  return (
    <div className="vault-layout page-enter">
      <section className="glass-panel vault-table-panel">
        <div className="toolbar">
          <label className="search-control">
            <Search size={16} />
            <input
              placeholder={t("search")}
              value={query.search ?? ""}
              onChange={(event) => setQuery({ ...query, search: event.target.value })}
            />
          </label>
          <select
            value={query.fileType ?? "All"}
            onChange={(event) => setQuery({ ...query, fileType: event.target.value as FileQuery["fileType"] })}
          >
            {["All", "Document", "Image", "Video", "Code", "Installer", "ArchivePackage", "Other"].map((item) => (
              <option key={item}>{item}</option>
            ))}
          </select>
          <select
            value={query.sortBy ?? "modified_at"}
            onChange={(event) => setQuery({ ...query, sortBy: event.target.value as FileQuery["sortBy"] })}
          >
            <option value="modified_at">{t("newest")}</option>
            <option value="size">{t("biggest")}</option>
            <option value="confidence">{t("strongest")}</option>
          </select>
          <label className="check-control">
            <input
              type="checkbox"
              checked={Boolean(query.onlyNeedsConfirmation)}
              onChange={(event) => setQuery({ ...query, onlyNeedsConfirmation: event.target.checked })}
            />
            {t("filterNeedsReview")}
          </label>
        </div>
        <FileTable files={files} onSelect={setSelectedFileId} selectedId={selectedFile?.id} t={t} />
      </section>
      <Inspector file={selectedFile} t={t} />
    </div>
  );
}

function TimelineView({
  snapshot,
  previews,
  selectedIds,
  setSelectedIds,
  onRenamePreview,
  executeSelected,
  t
}: {
  snapshot: AppSnapshot;
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
        {!previews.length ? (
          <div className="empty-state">{t("noOperations")}</div>
        ) : (
          <div className="preview-list">
            {previews.map((preview) => (
              <label className="preview-row" key={preview.id}>
                <input
                  type="checkbox"
                  disabled={preview.is_executable === false}
                  checked={selectedIds.has(preview.id)}
                  onChange={() => toggle(preview.id)}
                />
                <div>
                  <strong>{preview.old_name}</strong>
                  <span>{preview.source_path}</span>
                  <span>{preview.target_path}</span>
                  <input
                    className="inline-name-input"
                    value={preview.new_name}
                    disabled={!preview.editable_new_name || preview.is_executable === false}
                    onChange={(event) => onRenamePreview(preview.id, event.target.value)}
                    aria-label={t("newFileName")}
                  />
                  {preview.blocking_reason && <small>{preview.blocking_reason}</small>}
                </div>
                <em>{percent(preview.confidence)}</em>
              </label>
            ))}
          </div>
        )}
      </section>

      <section className="glass-panel operation-log-panel">
        <SectionTitle title={t("operationHistory")} body={t("timeMachineDesc")} />
        {!snapshot.operations.length ? (
          <div className="empty-state compact">{t("noOperationHistory")}</div>
        ) : (
          <div className="operation-list">
            {snapshot.operations.map((operation) => (
              <div className="operation-row" key={operation.id}>
                <RotateCcw size={16} />
                <div>
                  <strong>{operation.operation_type} / {t(operation.status)}</strong>
                  <span>{operation.source_path}</span>
                </div>
              </div>
            ))}
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
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RestoreView({ hasNativeApi, t }: { hasNativeApi: boolean; t: Translator }) {
  const [batches, setBatches] = useState<RestoreBatch[]>([]);
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
          <div className="preview-list">
            {preview.items.map((item) => (
              <div className="preview-row restore-item" key={item.log_id}>
                <span className={`status-dot ${item.can_restore ? "ok" : "blocked"}`} />
                <div>
                  <strong>{item.new_name} {"->"} {item.old_name}</strong>
                  <span>{item.current_path}</span>
                  <span>{item.restore_path}</span>
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
  snapshot,
  setSnapshot,
  hasNativeApi,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  snapshot: AppSnapshot;
  setSnapshot: (snapshot: AppSnapshot) => void;
  hasNativeApi: boolean;
  t: Translator;
}) {
  const [sources, setSources] = useState<SearchSource[]>(snapshot.searchSources);
  const [hotkey, setHotkey] = useState("CommandOrControl+K");
  const [settingsStatus, setSettingsStatus] = useState("");
  const fileManager = window.fileManager;

  useEffect(() => {
    setSources(snapshot.searchSources);
  }, [snapshot.searchSources]);

  useEffect(() => {
    if (!fileManager) return;
    fileManager.getSearchHotkey().then(setHotkey).catch(() => undefined);
    fileManager.getSearchSources().then(setSources).catch(() => undefined);
  }, [fileManager]);

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
    const result = await fileManager.setSearchHotkey(hotkey);
    setSettingsStatus(result.ok ? t("hotkeySaved") : t("hotkeyConflict"));
    setHotkey(result.hotkey);
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
          <div className="segmented compact">
            <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>
              {t("lightTheme")}
            </button>
            <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>
              {t("darkTheme")}
            </button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("folderNaming")}</strong>
            <span>{t("folderNamingDesc")}</span>
          </div>
          <div className="segmented compact">
            <button className="active">Career</button>
            <button>{t("chineseFolderNames")}</button>
          </div>
        </div>
        <div className="setting-row">
          <div>
            <strong>{t("searchHotkey")}</strong>
            <span>{t("searchHotkeyDesc")}</span>
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
          <div className="toggle-pill">{t("optional")}</div>
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
            <strong>15 {t("days")}</strong>
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
  t
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  files: FileRecord[];
  setView: (view: View) => void;
  setSelectedFileId: (id: string) => void;
  onClose: () => void;
  t: Translator;
}) {
  const [search, setSearch] = useState("");
  const [nativeResults, setNativeResults] = useState<SearchResult[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const fileManager = window.fileManager;
  const hasNativeApi = typeof fileManager !== "undefined";
  const fallbackResults: SearchResult[] = files
    .filter((file) => `${file.name} ${file.path} ${file.purpose}`.toLowerCase().includes(search.toLowerCase()))
    .slice(0, 8)
    .map((file) => ({ file, score: 10, matched_text: file.name }));
  const results = hasNativeApi ? nativeResults : fallbackResults;

  useEffect(() => {
    if (!fileManager) return;
    const timer = window.setTimeout(() => {
      fileManager.searchQuery({ query: search, limit: 12 })
        .then((next) => {
          setNativeResults(next);
          setActiveIndex(0);
        })
        .catch(() => setNativeResults([]));
    }, 40);
    return () => window.clearTimeout(timer);
  }, [fileManager, search]);

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

  function go(next: View) {
    setView(next);
    onClose();
  }

  function showDetails(file: FileRecord) {
    setSelectedFileId(file.id);
    go("library");
  }

  return (
    <div className="command-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className="command-modal"
        onKeyDown={(event) => {
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
            void openFile(results[activeIndex].file);
          }
          if (event.key === "Escape") onClose();
        }}
      >
        <div className="command-input-row">
          <Search size={20} />
          <input
            ref={inputRef}
            value={search}
            placeholder={t("commandPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button onClick={onClose} aria-label={t("close")}>
            <X size={16} />
          </button>
        </div>
        <div className="command-section">
          <span>{t("quickCommands")}</span>
          <button onClick={() => go("scanner")}>
            <Radar size={17} />
            {t("spaceScan")}
          </button>
          <button onClick={() => go("preview")}>
            <ListChecks size={17} />
            {t("openPreview")}
          </button>
          <button onClick={() => go("rules")}>
            <SlidersHorizontal size={17} />
            {t("openRuleBuilder")}
          </button>
        </div>
        <div className="command-section">
          <span>{t("bestMatches")}</span>
          {results.map(({ file }, index) => (
            <button
              key={file.id}
              className={index === activeIndex ? "active-result" : ""}
              onClick={() => openFile(file)}
            >
              <File size={17} />
              <div>
                <strong>{file.name}</strong>
                <small>{file.path}</small>
              </div>
              <em>{file.extension || file.file_type}</em>
              <span className="result-actions">
                <b onClick={(event) => { event.stopPropagation(); void revealFile(file); }}>{t("reveal")}</b>
                <b onClick={(event) => { event.stopPropagation(); showDetails(file); }}>{t("details")}</b>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
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

function FlowStep({ index, title, body }: { index: string; title: string; body: string }) {
  return (
    <div className="flow-step">
      <span>{index}</span>
      <div>
        <strong>{title}</strong>
        <em>{body}</em>
      </div>
    </div>
  );
}

function FileCard({ file, index, t }: { file: FileRecord; index: number; t: Translator }) {
  return (
    <div className="stack-card" style={{ "--delay": `${index * 70}ms` } as CSSProperties}>
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

function FileTable({
  files,
  selectedId,
  onSelect,
  t
}: {
  files: FileRecord[];
  selectedId?: string;
  onSelect: (id: string) => void;
  t: Translator;
}) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>{t("files")}</th>
            <th>{t("purpose")}</th>
            <th>{t("lifecycle")}</th>
            <th>{t("risk")}</th>
            <th>{t("action")}</th>
            <th>{t("confidence")}</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.id} className={selectedId === file.id ? "selected-row" : ""} onClick={() => onSelect(file.id)}>
              <td>
                <strong>{file.name}</strong>
                <span>{formatBytes(file.size)} / {file.file_type}</span>
              </td>
              <td>{file.purpose}</td>
              <td><span className="token">{file.lifecycle}</span></td>
              <td><RiskBadge risk={file.risk_level} t={t} /></td>
              <td>{file.suggested_action}</td>
              <td>{percent(file.confidence)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Inspector({ file, t }: { file?: FileRecord; t: Translator }) {
  if (!file) return null;
  return (
    <aside className="glass-panel inspector">
      <div className="inspector-head">
        <div>
          <span>{t("recentSignals")}</span>
          <h2>{file.name}</h2>
        </div>
        <RiskBadge risk={file.risk_level} t={t} />
      </div>
      <div className="inspector-grid">
        <span>{t("purpose")}</span><strong>{file.purpose}</strong>
        <span>{t("lifecycle")}</span><strong>{file.lifecycle}</strong>
        <span>{t("confidence")}</span><strong>{percent(file.confidence)}</strong>
        <span>{t("action")}</span><strong>{file.suggested_action}</strong>
      </div>
      <div className="explain-box">
        <strong>{t("matchedRules")}</strong>
        <p>{file.matched_rules.join(", ") || "-"}</p>
        <strong>{t("reason")}</strong>
        <p>{file.classification_reason || "-"}</p>
      </div>
      <div className="path-list">
        <span>{t("sourcePath")}</span>
        <code>{file.path}</code>
        <span>{t("targetPath")}</span>
        <code>{file.suggested_target_path || "-"}</code>
      </div>
    </aside>
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

function normalizePathLike(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
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
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
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
