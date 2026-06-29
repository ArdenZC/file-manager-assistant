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
import { useMemo } from "react";
import { CommandModal } from "./CommandModal";
import { ViewErrorBoundary } from "./ErrorBoundary";
import { AmbientMesh, CloseChoiceDialog, TitlebarTools, ZenMark } from "./ShellChrome";
import { useChromeContext, useSettingsContext } from "../contexts/AppContexts";
import { resolveEffectiveSearchScope } from "../hooks/useAppSettings";
import { hideToBackground } from "../hooks/useWindowBehavior";
import { useAppStore } from "../store/useAppStore";
import { useFileLibraryStore } from "../store/useFileLibraryStore";
import { useOperationQueueStore } from "../store/useOperationQueueStore";
import { useScanManagerStore } from "../store/useScanManagerStore";
import type { AppSettings, LibraryScope } from "../types/domain";
import type { Translator, View } from "../types/ui";
import { formatDate } from "../utils/format";
import { cn, glassButton, glassButtonPrimary, statusToast, toastTone } from "../utils/tw";
import { compactPath, libraryScopeLabel, readableError } from "../utils/viewHelpers";
import {
  HubView,
  RestoreView,
  RulesView,
  ScannerView,
  SettingsView,
  TimelineView,
  VaultView
} from "../views";

const appRoot =
  "relative h-screen min-h-[720px] min-w-[1080px] overflow-hidden bg-[var(--bg)] text-[var(--ink)]";
const searchWindowRoot =
  "relative h-screen w-screen overflow-hidden bg-transparent text-[var(--ink)]";
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

export function AppShell() {
  const {
    isSearchMode,
    isWindows,
    setIsCommandOpen,
    hotkeyLabel,
    view,
    isCommandOpen,
    isCloseChoiceOpen,
    onCancelCloseChoice,
    resolveCloseChoice,
    t
  } = useChromeContext();
  const stats = useFileLibraryStore((state) => state.stats);

  if (isSearchMode) return <SearchWindow />;

  const nav = navItems(t);
  const activeLabel = nav.find((item) => item.id === view)?.label ?? t("spaceScan");
  const scannerLastScanLabel = stats.lastScannedAt ? formatDate(stats.lastScannedAt) : t("notScannedYet");
  const headingDescription =
    view === "scanner"
      ? `${t("lastScan")}: ${scannerLastScanLabel}`
      : stats.lastScannedAt
        ? `${t("lastScan")}: ${formatDate(stats.lastScannedAt)}`
        : t("notScannedYet");

  return (
    <div className={appRoot}>
      <AmbientMesh />
      <header className={titlebar}>
        <div className="flex items-center justify-start">
          {!isWindows ? <MacWindowControls /> : <ChromeTools />}
        </div>
        <div className="flex items-center justify-center">
          <button className={cn(spotlightButton, noDrag)} onClick={() => setIsCommandOpen(true)}>
            <Search size={15} />
            <span>{t("globalSearch")}</span>
            <kbd>{hotkeyLabel}</kbd>
          </button>
        </div>
        <div className="flex items-center justify-end">
          {!isWindows ? <ChromeTools /> : <WindowsControls />}
        </div>
      </header>
      <div className={workspaceShell}>
        <Sidebar nav={nav} />
        <main className={workspaceClass}>
          <ViewHeading activeLabel={activeLabel} headingDescription={headingDescription} />
          <ToastContainer />
          <div className={viewStageClass}>
            <ViewErrorBoundary key={view}>
              <AppViewContent />
            </ViewErrorBoundary>
          </div>
        </main>
      </div>
      {isCommandOpen && <CommandLauncher />}
      {isCloseChoiceOpen && (
        <CloseChoiceDialog t={t} onCancel={onCancelCloseChoice} onChoose={resolveCloseChoice} />
      )}
    </div>
  );
}

function SearchWindow() {
  return (
    <div className={cn(searchWindowRoot, "flex items-center justify-center")}>
      <CommandLauncher standalone />
    </div>
  );
}

function CommandLauncher({ standalone = false }: { standalone?: boolean }) {
  const { commandInputRef, setView, setIsCommandOpen, platform, onError, t } = useChromeContext();
  const { settings } = useSettingsContext();
  const currentLibraryScope = useFileLibraryStore((state) => state.scope);
  const setSelectedFileId = useFileLibraryStore((state) => state.setSelectedFileId);
  const effectiveSearchScope = useMemo(
    () => resolveEffectiveSearchScope(settings, currentLibraryScope),
    [currentLibraryScope, settings]
  );
  const searchScopeLabel = commandSearchScopeLabel(settings, currentLibraryScope, t);
  const searchScopeEmptyMessage = commandSearchScopeEmptyMessage(settings, currentLibraryScope, t);

  function closeCommand() {
    setIsCommandOpen(false);
    if (standalone) {
      void hideToBackground((error) => {
        onError(`${t("windowActionFailed")}：${readableError(error)}`);
      });
    }
  }

  return (
    <CommandModal
      inputRef={commandInputRef}
      setView={setView}
      setSelectedFileId={setSelectedFileId}
      onClose={closeCommand}
      platform={platform}
      t={t}
      onError={onError}
      searchScope={effectiveSearchScope}
      searchScopeLabel={searchScopeLabel}
      searchScopeEmptyMessage={searchScopeEmptyMessage}
      standalone={standalone}
    />
  );
}

function commandSearchScopeLabel(settings: AppSettings, currentLibraryScope: LibraryScope, t: Translator) {
  if (settings.searchScopeMode === "all") return `${t("searchScopeLabel")}: ${t("searchScopeAllIndexed")}`;
  if (settings.searchScopeMode === "current_scan") {
    const currentLabel = libraryScopeLabel(currentLibraryScope, t("searchScopeAllIndexed"), t("noFolderSelected"));
    return currentLibraryScope.kind === "all"
      ? `${t("searchScopeLabel")}: ${t("searchScopeAllIndexed")}`
      : `${t("searchScopeLabel")}: ${t("searchScopeCurrentScan")}${currentLibraryScope.roots.length ? ` · ${currentLabel}` : ""}`;
  }

  const enabledRoots = settings.customSearchRoots.filter((root) => root.enabled && root.path.trim());
  if (!enabledRoots.length) return `${t("searchScopeLabel")}: ${t("searchScopeCustomEmpty")}`;
  const first = compactPath(enabledRoots[0].path, 42);
  const suffix = enabledRoots.length > 1 ? ` +${enabledRoots.length - 1}` : "";
  return `${t("searchScopeLabel")}: ${t("searchScopeCustomRoots")}: ${first}${suffix}`;
}

function commandSearchScopeEmptyMessage(settings: AppSettings, currentLibraryScope: LibraryScope, t: Translator) {
  if (settings.searchScopeMode === "custom_roots" && !settings.customSearchRoots.some((root) => root.enabled && root.path.trim())) {
    return t("searchScopeCustomEmpty");
  }
  if (settings.searchScopeMode === "current_scan" && currentLibraryScope.kind === "current_scan" && currentLibraryScope.roots.length === 0) {
    return t("searchScopeCurrentScanEmpty");
  }
  return "";
}

function ChromeTools() {
  const { language, theme, effectiveTheme, setLanguage, setTheme } = useChromeContext();

  return (
    <TitlebarTools
      language={language}
      theme={theme}
      effectiveTheme={effectiveTheme}
      setLanguage={setLanguage}
      setTheme={setTheme}
    />
  );
}

function MacWindowControls() {
  const { handleWindowAction, t } = useChromeContext();

  return (
    <div className={cn("flex items-center gap-2", noDrag)} aria-label="Window controls">
      <button className="h-3 w-3 rounded-full bg-red-500 shadow-sm" onClick={() => handleWindowAction("close")} aria-label={t("close")} />
      <button className="h-3 w-3 rounded-full bg-amber-400 shadow-sm" onClick={() => handleWindowAction("minimize")} aria-label={t("minimize")} />
      <button className="h-3 w-3 rounded-full bg-emerald-500 shadow-sm" onClick={() => handleWindowAction("maximize")} aria-label={t("maximize")} />
    </div>
  );
}

function WindowsControls() {
  const { handleWindowAction, t } = useChromeContext();

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

function Sidebar({ nav }: { nav: ReturnType<typeof navItems> }) {
  const { view, setView, t } = useChromeContext();
  const previewActionCount = useOperationQueueStore((state) => state.previewActionCount);

  return (
    <aside className={sidebarClass}>
      <div className="flex items-center gap-3">
        <ZenMark />
        <div>
          <strong className="block text-base font-semibold">{t("appName")}</strong>
          <span className="block text-xs text-[var(--muted)]">{t("appSubtitle")}</span>
        </div>
      </div>
      <nav className="flex flex-1 flex-col gap-1">
        {nav.map((item, index) => (
          <button
            key={item.id}
            className={cn(navItemBase, view === item.id && navItemActive, index === 4 && "mt-3 border-t border-[var(--line-dark)] pt-4")}
            onClick={() => setView(item.id)}
          >
            <item.icon size={18} />
            <span>{item.label}</span>
            {item.id === "preview" && previewActionCount > 0 && (
              <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500/10 px-1 text-[11px] font-medium text-red-600 dark:text-red-300" aria-label={`${previewActionCount} pending`}>
                {previewActionCount}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="mt-auto flex items-start gap-3 rounded-2xl border border-[var(--line-dark)] bg-white/30 p-3 text-sm dark:bg-white/5">
        <LockKeyhole size={18} />
        <div>
          <strong className="block text-[var(--ink)]">{t("privateByDefault")}</strong>
          <span className="block text-xs text-[var(--muted)]">{t("privacyLine")}</span>
        </div>
      </div>
    </aside>
  );
}

function ViewHeading({
  activeLabel,
  headingDescription
}: {
  activeLabel: string;
  headingDescription: string;
}) {
  const { view, t } = useChromeContext();
  const isScanning = useScanManagerStore((state) => state.isScanning);
  const handleChooseFolders = useScanManagerStore((state) => state.handleChooseFolders);
  const handleScan = useScanManagerStore((state) => state.handleScan);

  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <div>
        <h1 className="m-0 text-2xl font-semibold">{activeLabel}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{headingDescription}</p>
      </div>
      {view !== "scanner" && (
        <div className="flex items-center gap-2">
          <button className={glassButton} onClick={handleChooseFolders} disabled={isScanning}>
            <FolderSearch size={17} />
            <span>{t("chooseFolders")}</span>
          </button>
          <button className={glassButtonPrimary} onClick={handleScan} disabled={isScanning}>
            <RefreshCw size={17} className={isScanning ? "animate-spin" : ""} />
            <span>{t("scanCommon")}</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ToastContainer() {
  const toast = useAppStore((state) => state.toast);

  if (!toast) return null;

  return (
    <div className={cn(statusToast, toastTone(toast.type))}>
      {toast.message}
    </div>
  );
}

function AppViewContent() {
  const { view } = useChromeContext();

  if (view === "scanner") return <ScannerView />;
  if (view === "organize") return <HubView />;
  if (view === "library") return <VaultView />;
  if (view === "preview") return <TimelineView />;
  if (view === "rules") return <RulesView />;
  if (view === "restore") return <RestoreView />;
  return <SettingsView />;
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
  ] satisfies Array<{ id: View; label: string; icon: typeof Radar }>;
}
