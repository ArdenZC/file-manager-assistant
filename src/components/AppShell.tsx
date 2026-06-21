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
import type { OperationProgressPayload, RuleExecutionSummary, ScanProgressPayload } from "../api/tauriApi";
import { CommandModal } from "./CommandModal";
import { ViewErrorBoundary } from "./ErrorBoundary";
import { AmbientMesh, CloseChoiceDialog, TitlebarTools, ZenMark } from "./ShellChrome";
import type { Language } from "../i18n";
import type {
  CloseBehavior,
  DashboardStats,
  DefaultScanFolder,
  FileQueryResult,
  FileRecord,
  FolderNamingLanguage,
  OperationLog,
  OperationPreview,
  RestoreRetentionDays,
  Rule
} from "../types/domain";
import type { ThemeMode, Translator, View } from "../types/ui";
import { formatDate } from "../utils/format";
import { cn, glassButton, glassButtonPrimary, statusToast, toastTone } from "../utils/tw";
import {
  HubView,
  RestoreView,
  RulesView,
  ScannerView,
  SettingsView,
  TimelineView,
  VaultView
} from "../views/AppViews";

const appRoot =
  "relative h-screen min-h-[720px] min-w-[1080px] overflow-hidden bg-[var(--bg)] text-[var(--ink)]";
const titlebar =
  "relative z-30 grid h-12 grid-cols-[260px_1fr_260px] items-center border-b border-[var(--line-dark)] bg-[var(--surface-soft)] px-4 backdrop-blur-2xl [-webkit-app-region:drag]";
const noDrag = "[-webkit-app-region:no-drag]";
const spotlightButton =
  "mx-auto inline-flex h-8 min-w-80 items-center justify-between gap-3 rounded-full border border-[var(--line-dark)] bg-white/40 px-3 text-xs text-[var(--muted)] shadow-sm transition hover:bg-white/70 dark:bg-white/5 dark:hover:bg-white/10 [&_kbd]:rounded-md [&_kbd]:border [&_kbd]:border-[var(--line-dark)] [&_kbd]:px-1.5 [&_kbd]:py-0.5 [&_kbd]:text-[11px] [&_kbd]:text-[var(--quiet)]";
const workspaceShell = "relative z-10 grid h-[calc(100vh-48px)] grid-cols-[260px_minmax(0,1fr)]";
const sidebarClass =
  "flex min-h-0 flex-col gap-5 border-r border-[var(--line-dark)] bg-[var(--surface-soft)] px-5 py-6 backdrop-blur-2xl";
const navItemBase =
  "flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm font-medium text-[var(--muted)] transition hover:bg-white/40 hover:text-[var(--ink)] dark:hover:bg-white/10";
const navItemActive = "bg-blue-500/10 text-[var(--ink)] shadow-sm";
const workspaceClass = "min-w-0 overflow-hidden px-6 py-5";
const viewStageClass = "h-[calc(100vh-170px)] overflow-hidden";

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
  toggleRuleEnabled: (rule: Rule, enabled: boolean) => Promise<void>;
  deleteRule: (rule: Rule) => Promise<void>;
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
  operationProgress: OperationProgressPayload | null;
  isOperationCanceling: boolean;
  executeSelected: () => Promise<void>;
  restoreOperationLogs: (logs: OperationLog[]) => Promise<void>;
  cancelOperations: () => Promise<void>;
  onRenamePreview: (id: string, name: string) => void;
  toast: { message: string; type: "success" | "error" | "info" } | null;
  onError: (message: string) => void;
  commandInputRef: RefObject<HTMLInputElement | null>;
  isCommandOpen: boolean;
  setIsCommandOpen: Dispatch<SetStateAction<boolean>>;
  platform: NodeJS.Platform | "browser";
  isWindows: boolean;
  hotkeyLabel: string;
  isSearchMode: boolean;
  closeBehavior: CloseBehavior;
  setCloseBehavior: (next: CloseBehavior) => Promise<boolean>;
  folderNamingLanguage: FolderNamingLanguage;
  setFolderNamingLanguage: (next: FolderNamingLanguage) => Promise<boolean>;
  defaultScanFolders: DefaultScanFolder[];
  setDefaultScanFolders: (next: DefaultScanFolder[]) => Promise<boolean>;
  restoreRetentionDays: RestoreRetentionDays;
  setRestoreRetentionDays: (next: RestoreRetentionDays) => Promise<boolean>;
  launchAtLogin: boolean;
  setLaunchAtLogin: (next: boolean) => Promise<boolean>;
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
    <div className={appRoot}>
      <AmbientMesh />
      <header className={titlebar}>
        <div className="flex items-center justify-start">
          {!props.isWindows ? <MacWindowControls {...props} /> : <TitlebarTools {...props} />}
        </div>
        <div className="flex items-center justify-center">
          <button className={cn(spotlightButton, noDrag)} onClick={() => props.setIsCommandOpen(true)}>
            <Search size={15} />
            <span>{props.t("globalSearch")}</span>
            <kbd>{props.hotkeyLabel}</kbd>
          </button>
        </div>
        <div className="flex items-center justify-end">
          {!props.isWindows ? <TitlebarTools {...props} /> : <WindowsControls {...props} />}
        </div>
      </header>
      <div className={workspaceShell}>
        <Sidebar {...props} nav={nav} />
        <main className={workspaceClass}>
          <ViewHeading {...props} activeLabel={activeLabel} headingDescription={headingDescription} />
          {props.toast && (
            <div className={cn(statusToast, toastTone(props.toast.type))}>
              {props.toast.message}
            </div>
          )}
          <div className={viewStageClass}>
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
    <div className={cn(appRoot, "flex items-center justify-center")}>
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
    <div className={cn("flex items-center gap-2", noDrag)} aria-label="Window controls">
      <button className="h-3 w-3 rounded-full bg-red-500 shadow-sm" onClick={() => handleWindowAction("close")} aria-label={t("close")} />
      <button className="h-3 w-3 rounded-full bg-amber-400 shadow-sm" onClick={() => handleWindowAction("minimize")} aria-label={t("minimize")} />
      <button className="h-3 w-3 rounded-full bg-emerald-500 shadow-sm" onClick={() => handleWindowAction("maximize")} aria-label={t("maximize")} />
    </div>
  );
}

function WindowsControls({ handleWindowAction, t }: AppShellProps) {
  return (
    <div className={cn("flex items-center overflow-hidden rounded-lg border border-[var(--line-dark)] bg-white/30 dark:bg-white/5", noDrag)} aria-label="Window controls">
      <button className="grid h-8 w-10 place-items-center text-[var(--muted)] transition hover:bg-white/50 hover:text-[var(--ink)] dark:hover:bg-white/10" onClick={() => handleWindowAction("minimize")} aria-label={t("minimize")}>
        <Minus size={15} strokeWidth={1.6} />
      </button>
      <button className="grid h-8 w-10 place-items-center text-[var(--muted)] transition hover:bg-white/50 hover:text-[var(--ink)] dark:hover:bg-white/10" onClick={() => handleWindowAction("maximize")} aria-label={t("maximize")}>
        <Square size={12} strokeWidth={1.6} />
      </button>
      <button className="grid h-8 w-10 place-items-center text-[var(--muted)] transition hover:bg-red-500 hover:text-white" onClick={() => handleWindowAction("close")} aria-label={t("close")}>
        <X size={16} strokeWidth={1.6} />
      </button>
    </div>
  );
}

function Sidebar(props: AppShellProps & { nav: ReturnType<typeof navItems> }) {
  return (
    <aside className={sidebarClass}>
      <div className="flex items-center gap-3">
        <ZenMark />
        <div>
          <strong className="block text-base font-semibold">{props.t("appName")}</strong>
          <span className="block text-xs text-[var(--muted)]">{props.t("appSubtitle")}</span>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {props.nav.map((item, index) => (
          <button
            key={item.id}
            className={cn(navItemBase, props.view === item.id && navItemActive, index === 4 && "mt-3 border-t border-[var(--line-dark)] pt-4")}
            onClick={() => props.setView(item.id)}
          >
            <item.icon size={18} />
            <span>{item.label}</span>
            {item.id === "preview" && props.previewActionCount > 0 && (
              <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500/10 px-1 text-[11px] font-medium text-red-600 dark:text-red-300" aria-label={`${props.previewActionCount} pending`}>
                {props.previewActionCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="mt-auto flex items-start gap-3 rounded-2xl border border-[var(--line-dark)] bg-white/30 p-3 text-sm dark:bg-white/5">
        <LockKeyhole size={18} />
        <div>
          <strong className="block text-[var(--ink)]">{props.t("privateByDefault")}</strong>
          <span className="block text-xs text-[var(--muted)]">{props.t("privacyLine")}</span>
        </div>
      </div>
    </aside>
  );
}

function ViewHeading(props: AppShellProps & { activeLabel: string; headingDescription: string }) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <div>
        <h1 className="m-0 text-2xl font-semibold">{props.activeLabel}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{props.headingDescription}</p>
      </div>
      {props.view !== "scanner" && (
        <div className="flex items-center gap-2">
          <button className={glassButton} onClick={props.handleChooseFolders} disabled={props.isScanning}>
            <FolderSearch size={17} />
            <span>{props.t("chooseFolders")}</span>
          </button>
          <button className={glassButtonPrimary} onClick={props.handleScan} disabled={props.isScanning}>
            <RefreshCw size={17} className={props.isScanning ? "animate-spin" : ""} />
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
  if (props.view === "organize") return <HubView files={props.files} rules={props.rules} onRunDispatch={props.runDispatch} onError={props.onError} setView={props.setView} t={props.t} />;
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
        onError={props.onError}
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
        operationProgress={props.operationProgress}
        isOperationCanceling={props.isOperationCanceling}
        cancelOperations={props.cancelOperations}
        t={props.t}
      />
    );
  }
  if (props.view === "rules") {
    return (
      <RulesView
        rules={props.rules}
        onSave={props.saveRule}
        onToggleRuleEnabled={props.toggleRuleEnabled}
        onDeleteRule={props.deleteRule}
        t={props.t}
      />
    );
  }
  if (props.view === "restore") {
    return (
      <RestoreView
        logs={props.operationLogs}
        onRestore={props.restoreOperationLogs}
        operationProgress={props.operationProgress}
        isOperationCanceling={props.isOperationCanceling}
        cancelOperations={props.cancelOperations}
        t={props.t}
      />
    );
  }
  return (
    <SettingsView
      language={props.language}
      setLanguage={props.setLanguage}
      theme={props.theme}
      setTheme={props.setTheme}
      platform={props.platform}
      closeBehavior={props.closeBehavior}
      setCloseBehavior={props.setCloseBehavior}
      folderNamingLanguage={props.folderNamingLanguage}
      setFolderNamingLanguage={props.setFolderNamingLanguage}
      defaultScanFolders={props.defaultScanFolders}
      setDefaultScanFolders={props.setDefaultScanFolders}
      restoreRetentionDays={props.restoreRetentionDays}
      setRestoreRetentionDays={props.setRestoreRetentionDays}
      launchAtLogin={props.launchAtLogin}
      setLaunchAtLogin={props.setLaunchAtLogin}
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
