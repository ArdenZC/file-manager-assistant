import type { Dispatch, RefObject, SetStateAction } from "react";
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
import type { RuleExecutionSummary, ScanProgressPayload } from "../api/tauriApi";
import { CommandModal } from "./CommandModal";
import { ViewErrorBoundary } from "./ErrorBoundary";
import { AmbientMesh, CloseChoiceDialog, TitlebarTools, ZenMark } from "./ShellChrome";
import type { Language } from "../i18n";
import type {
  CloseBehavior,
  DashboardStats,
  FileQueryResult,
  FileRecord,
  OperationLog,
  OperationPreview,
  Rule
} from "../types/domain";
import type { ThemeMode, Translator, View } from "../types/ui";
import { formatDate } from "../utils/format";
import {
  HubView,
  RestoreView,
  RulesView,
  ScannerView,
  SettingsView,
  TimelineView,
  VaultView
} from "../views/AppViews";

interface AppShellProps {
  language: Language;
  setLanguage: (language: Language) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  effectiveTheme: Exclude<ThemeMode, "system">;
  view: View;
  setView: (view: View) => void;
  searchQuery: string;
  setSearchQuery: (searchQuery: string) => void;
  stats: DashboardStats;
  libraryPage: FileQueryResult;
  setLibraryPage: Dispatch<SetStateAction<FileQueryResult>>;
  selectedFile: FileRecord | undefined;
  setSelectedFileId: Dispatch<SetStateAction<string>>;
  files: FileRecord[];
  rules: Rule[];
  saveRule: (rule: Rule) => Promise<void>;
  runDispatch: () => Promise<RuleExecutionSummary>;
  selectedFolders: string[];
  isScanning: boolean;
  scanState: { progress: ScanProgressPayload | null };
  handleScan: () => Promise<void>;
  handleChooseFolders: () => Promise<void>;
  cancelScan: () => Promise<void>;
  operationLogs: OperationLog[];
  selectedOperationIds: Set<string>;
  setSelectedOperationIds: Dispatch<SetStateAction<Set<string>>>;
  displayPreviews: OperationPreview[];
  previewActionCount: number;
  executeSelected: () => Promise<void>;
  restoreOperationLogs: (logs: OperationLog[]) => Promise<void>;
  onRenamePreview: (id: string, name: string) => void;
  toast: { message: string; type: "success" | "error" | "info" } | null;
  commandInputRef: RefObject<HTMLInputElement | null>;
  isCommandOpen: boolean;
  setIsCommandOpen: Dispatch<SetStateAction<boolean>>;
  platform: NodeJS.Platform | "browser";
  isWindows: boolean;
  hotkeyLabel: string;
  isSearchMode: boolean;
  closeBehavior: CloseBehavior;
  setCloseBehavior: (next: CloseBehavior) => Promise<void>;
  isCloseChoiceOpen: boolean;
  handleWindowAction: (action: "minimize" | "maximize" | "close") => Promise<void>;
  resolveCloseChoice: (action: "minimize" | "quit", remember: boolean) => Promise<void>;
  onCancelCloseChoice: () => void;
  loadStats: () => Promise<void>;
  t: Translator;
}

export function AppShell(props: AppShellProps) {
  if (props.isSearchMode) return <SearchWindow {...props} />;

  const nav = navItems(props.t);
  const activeLabel = nav.find((item) => item.id === props.view)?.label ?? props.t("spaceScan");
  const scannerLastScanLabel = props.stats.lastScannedAt ? formatDate(props.stats.lastScannedAt) : props.t("notScannedYet");
  const headingDescription =
    props.view === "scanner"
      ? `${props.t("lastScan")}: ${scannerLastScanLabel}`
      : props.stats.lastScannedAt
        ? `${props.t("lastScan")}: ${formatDate(props.stats.lastScannedAt)}`
        : props.t("notScannedYet");

  return (
    <div className="zen-app">
      <AmbientMesh />
      <header className={`native-titlebar ${props.isWindows ? "is-windows" : "is-macos"}`}>
        <div className="titlebar-left">
          {!props.isWindows ? <MacWindowControls {...props} /> : <TitlebarTools {...props} />}
        </div>
        <div className="titlebar-center">
          <button className="spotlight-trigger" onClick={() => props.setIsCommandOpen(true)}>
            <Search size={15} />
            <span>{props.t("globalSearch")}</span>
            <kbd>{props.hotkeyLabel}</kbd>
          </button>
        </div>
        <div className="titlebar-right">
          {!props.isWindows ? <TitlebarTools {...props} /> : <WindowsControls {...props} />}
        </div>
      </header>
      <div className="zen-shell">
        <Sidebar {...props} nav={nav} />
        <main className="zen-workspace">
          <ViewHeading {...props} activeLabel={activeLabel} headingDescription={headingDescription} />
          {props.toast && (
            <div className={`system-toast system-toast--${props.toast.type}`}>
              {props.toast.message}
            </div>
          )}
          <div className="view-stage">
            <ViewErrorBoundary key={props.view}>
              <AppViewContent {...props} />
            </ViewErrorBoundary>
          </div>
        </main>
      </div>
      {props.isCommandOpen && <CommandLauncher {...props} />}
      {props.isCloseChoiceOpen && (
        <CloseChoiceDialog t={props.t} onCancel={props.onCancelCloseChoice} onChoose={props.resolveCloseChoice} />
      )}
    </div>
  );
}

function SearchWindow(props: AppShellProps) {
  return (
    <div className="zen-app search-window">
      {props.isCommandOpen && <CommandLauncher {...props} standalone />}
    </div>
  );
}

function CommandLauncher(props: AppShellProps & { standalone?: boolean }) {
  return (
    <CommandModal
      inputRef={props.commandInputRef}
      setView={props.setView}
      setSelectedFileId={props.setSelectedFileId}
      onClose={() => props.setIsCommandOpen(false)}
      platform={props.platform}
      t={props.t}
      standalone={props.standalone}
    />
  );
}

function MacWindowControls({ handleWindowAction, t }: AppShellProps) {
  return (
    <div className="window-controls" aria-label="Window controls">
      <button className="traffic-dot red" onClick={() => handleWindowAction("close")} aria-label={t("close")} />
      <button className="traffic-dot yellow" onClick={() => handleWindowAction("minimize")} aria-label={t("minimize")} />
      <button className="traffic-dot green" onClick={() => handleWindowAction("maximize")} aria-label={t("maximize")} />
    </div>
  );
}

function WindowsControls({ handleWindowAction, t }: AppShellProps) {
  return (
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
  );
}

function Sidebar(props: AppShellProps & { nav: ReturnType<typeof navItems> }) {
  return (
    <aside className="zen-sidebar">
      <div className="brand-block">
        <ZenMark />
        <div>
          <strong>{props.t("appName")}</strong>
          <span>{props.t("appSubtitle")}</span>
        </div>
      </div>
      <nav className="zen-nav">
        {props.nav.map((item, index) => (
          <button
            key={item.id}
            className={`zen-nav-item ${props.view === item.id ? "active" : ""} ${index === 4 ? "with-divider" : ""}`}
            onClick={() => props.setView(item.id)}
          >
            <item.icon size={18} />
            <span>{item.label}</span>
            {item.id === "preview" && props.previewActionCount > 0 && (
              <span className="nav-badge" aria-label={`${props.previewActionCount} pending`}>
                {props.previewActionCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="privacy-card">
        <LockKeyhole size={18} />
        <div>
          <strong>{props.t("privateByDefault")}</strong>
          <span>{props.t("privacyLine")}</span>
        </div>
      </div>
    </aside>
  );
}

function ViewHeading(props: AppShellProps & { activeLabel: string; headingDescription: string }) {
  return (
    <div className="view-heading">
      <div>
        <h1>{props.activeLabel}</h1>
        <p>{props.headingDescription}</p>
      </div>
      {props.view !== "scanner" && (
        <div className="view-heading-actions">
          <button className="glass-button" onClick={props.handleChooseFolders} disabled={props.isScanning}>
            <FolderSearch size={17} />
            <span>{props.t("chooseFolders")}</span>
          </button>
          <button className="glass-button primary" onClick={props.handleScan} disabled={props.isScanning}>
            <RefreshCw size={17} className={props.isScanning ? "spin" : ""} />
            <span>{props.t("scanCommon")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function AppViewContent(props: AppShellProps) {
  if (props.view === "scanner") {
    return (
      <ScannerView
        stats={props.stats}
        files={props.files}
        selectedFolders={props.selectedFolders}
        isScanning={props.isScanning}
        scanProgress={props.scanState.progress}
        chooseFolders={props.handleChooseFolders}
        scanCommon={props.handleScan}
        cancelScan={props.cancelScan}
        t={props.t}
      />
    );
  }
  if (props.view === "organize") return <HubView files={props.files} rules={props.rules} onRunDispatch={props.runDispatch} setView={props.setView} t={props.t} />;
  if (props.view === "library") {
    return (
      <VaultView
        page={props.libraryPage}
        setPage={props.setLibraryPage}
        selectedFile={props.selectedFile}
        searchQuery={props.searchQuery}
        setSearchQuery={props.setSearchQuery}
        setSelectedFileId={props.setSelectedFileId}
        onRefreshStats={props.loadStats}
        t={props.t}
      />
    );
  }
  if (props.view === "preview") {
    return (
      <TimelineView
        previews={props.displayPreviews}
        selectedIds={props.selectedOperationIds}
        setSelectedIds={props.setSelectedOperationIds}
        onRenamePreview={props.onRenamePreview}
        executeSelected={props.executeSelected}
        t={props.t}
      />
    );
  }
  if (props.view === "rules") return <RulesView rules={props.rules} onSave={props.saveRule} t={props.t} />;
  if (props.view === "restore") return <RestoreView logs={props.operationLogs} onRestore={props.restoreOperationLogs} t={props.t} />;
  return (
    <SettingsView
      language={props.language}
      setLanguage={props.setLanguage}
      theme={props.theme}
      setTheme={props.setTheme}
      platform={props.platform}
      closeBehavior={props.closeBehavior}
      setCloseBehavior={props.setCloseBehavior}
      t={props.t}
    />
  );
}

function navItems(t: Translator) {
  return [
    { id: "scanner" as const, label: t("spaceScan"), icon: Radar },
    { id: "organize" as const, label: t("smartDispatch"), icon: LayoutGrid },
    { id: "library" as const, label: t("fileLibrary"), icon: Archive },
    { id: "preview" as const, label: t("previewExecute"), icon: ListChecks },
    { id: "rules" as const, label: t("ruleEngine"), icon: SlidersHorizontal },
    { id: "restore" as const, label: t("restoreRecords"), icon: Clock3 },
    { id: "settings" as const, label: t("settings"), icon: Settings }
  ];
}
