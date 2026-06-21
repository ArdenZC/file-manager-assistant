import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion, type Variants } from "motion/react";
import { Check, ChevronRight, File, Folder, FolderOpen, FolderSearch, Play, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from "lucide-react";
import { tauriApi, type OperationProgressPayload, type RuleExecutionSummary, type ScanProgressPayload } from "../api/tauriApi";
import { nextDefaultScanFolders } from "../hooks/useAppSettings";
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
  Lifecycle,
  Purpose,
  Rule,
  RuleCondition,
  RuleConditionGroup,
  RuleOperator
} from "../types/domain";
import type { ThemeMode, Translator, View } from "../types/ui";
import { formatBytes, percent } from "../utils/format";
import {
  compactPath,
  defaultPlatformAccelerator,
  groupOperationPreviews,
  localId,
  nowIso,
  readableError,
  splitDisplaySize
} from "../utils/viewHelpers";
import { shouldVirtualizeList } from "../utils/virtualization";
import {
  cn,
  emptyState,
  glassButton,
  glassButtonPrimary,
  glassPanel,
  inputSurface,
  sectionTitle,
  selectSurface,
  statusToast,
  toneClasses,
  virtualList,
  virtualRow as virtualRowClass,
  virtualSpacer
} from "../utils/tw";

const LIBRARY_PAGE_SIZE = 50;
const HUB_FILE_ROW_HEIGHT = 82;
const BUCKET_FILE_ROW_HEIGHT = 48;
const ASSET_GRID_ROW_HEIGHT = 234;
const PREVIEW_ROW_HEIGHT = 156;
const RULE_ROW_HEIGHT = 68;

const RULE_FIELD_OPTIONS = [
  "name",
  "extension",
  "file_type",
  "path",
  "directory",
  "size",
  "modified_at",
  "risk_level"
] as const satisfies readonly RuleCondition["field"][];
const RULE_OPERATOR_OPTIONS = [
  "contains",
  "equals",
  "startsWith",
  "endsWith",
  "greaterThan",
  "lessThan",
  "olderThanDays",
  "newerThanDays"
] as const satisfies readonly RuleCondition["operator"][];
const RULE_PURPOSE_OPTIONS = ["Temporary", "Career", "Finance", "Study", "Project", "Personal", "Media", "Unknown"] as const satisfies readonly Purpose[];
const RULE_LIFECYCLE_OPTIONS = ["Inbox", "Active", "Reference", "Archive", "Disposable", "Sensitive"] as const satisfies readonly Lifecycle[];
const RULE_LOGIC_OPTIONS = ["AND", "OR"] as const satisfies readonly RuleOperator[];
const HUB_BUCKET_KEYS = ["CoreAssets", "QuietArchive", "CleanupLane", "PrivacyVault"] as const;

export type HubBucketKey = typeof HUB_BUCKET_KEYS[number];
export type HubBucketGroups = Record<HubBucketKey, FileRecord[]>;

function createEmptyHubBucketGroups(): HubBucketGroups {
  return {
    CoreAssets: [],
    QuietArchive: [],
    CleanupLane: [],
    PrivacyVault: []
  };
}

export function getHubBucketKey(file: FileRecord): HubBucketKey {
  if (file.risk_level === "Sensitive") return "PrivacyVault";
  if (file.lifecycle === "Archive") return "QuietArchive";
  if (file.suggested_action === "DeleteCandidate" || file.suggested_action === "Review") return "CleanupLane";
  return "CoreAssets";
}

export function groupFilesByHubBucket(files: readonly FileRecord[]): HubBucketGroups {
  return files.reduce((groups, file) => {
    groups[getHubBucketKey(file)].push(file);
    return groups;
  }, createEmptyHubBucketGroups());
}

export interface RevealFileFromCardOptions {
  path: string;
  onError: (message: string) => void;
  stopPropagation: () => void;
  reveal?: (path: string) => Promise<void>;
}

export async function revealFileFromCard({
  path,
  onError,
  stopPropagation,
  reveal = tauriApi.revealInFolder
}: RevealFileFromCardOptions): Promise<void> {
  stopPropagation();
  try {
    await reveal(path);
  } catch (error) {
    onError(readableError(error));
  }
}

const listMotion: Variants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.035,
      delayChildren: 0.03
    }
  }
};

const itemMotion: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.985, filter: "blur(3px)" },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { type: "spring", stiffness: 280, damping: 26 }
  }
};

const pageSurface = "h-full min-h-0 overflow-auto pr-1";
const panelSurface = cn(glassPanel, "min-h-0 p-5");
const rowSurface =
  "rounded-2xl border border-[var(--line)] bg-white/30 p-3 text-left shadow-sm transition dark:bg-white/5";
const compactRowSurface =
  "rounded-xl border border-[var(--line)] bg-white/30 px-3 py-2 text-left transition dark:bg-white/5";
const mutedText = "text-sm text-[var(--muted)]";
const quietText = "text-xs text-[var(--quiet)]";
const formGrid = "grid grid-cols-2 gap-3 [&_label]:grid [&_label]:gap-1.5 [&_label]:text-sm [&_label]:font-medium [&_label]:text-[var(--muted)]";
const segmented = "inline-flex items-center gap-1 rounded-xl border border-[var(--line)] bg-white/25 p-1 dark:bg-white/5";

function segmentButton(active: boolean): string {
  return cn(
    "rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] transition hover:bg-white/50 hover:text-[var(--ink)] dark:hover:bg-white/10",
    active && "bg-blue-500 text-white shadow-sm hover:bg-blue-500 hover:text-white"
  );
}

export interface RuleBuilderDraft {
  id?: string;
  name: string;
  rootOperator: RuleOperator;
  groups: RuleConditionGroup[];
  purpose: Purpose;
  lifecycle: Lifecycle;
  weight: number;
  now: string;
}

export function buildRuleFromBuilderDraft(draft: RuleBuilderDraft): Rule {
  return {
    id: draft.id ?? localId("rule"),
    name: draft.name,
    source: "user",
    enabled: true,
    priority: 75,
    weight: draft.weight,
    root_operator: draft.rootOperator,
    groups: draft.groups.map((group) => ({
      ...group,
      conditions: group.conditions.map((condition) => ({ ...condition }))
    })),
    action: {
      purpose: draft.purpose,
      lifecycle: draft.lifecycle,
      suggested_action: "Move",
      target_template: "00_Inbox/Screenshots",
      context: "Screenshots"
    },
    created_at: draft.now,
    updated_at: draft.now
  };
}

function createRuleCondition(overrides: Partial<RuleCondition> = {}): RuleCondition {
  return {
    id: localId("cond"),
    field: "name",
    operator: "contains",
    value: "screenshot",
    ...overrides
  };
}

function createRuleGroup(conditionOverrides: Partial<RuleCondition> = {}): RuleConditionGroup {
  return {
    id: localId("group"),
    operator: "AND",
    conditions: [createRuleCondition(conditionOverrides)]
  };
}

function toggleSwitch(on: boolean): string {
  return cn(
    "relative h-7 w-12 rounded-full border border-[var(--line)] bg-slate-300/50 transition disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/10 [&_i]:absolute [&_i]:left-1 [&_i]:top-1 [&_i]:h-5 [&_i]:w-5 [&_i]:rounded-full [&_i]:bg-white [&_i]:shadow-sm [&_i]:transition",
    on && "bg-blue-500 [&_i]:translate-x-5"
  );
}

function sourceBadge(source: string): string {
  return cn(
    "rounded-full border px-2 py-1 text-xs font-medium",
    source === "user" || source === "user_space" ? toneClasses("green") : toneClasses("blue")
  );
}

export function ScannerView({
  stats,
  files,
  selectedFolders,
  isScanning,
  scanProgress,
  chooseFolders,
  scanCommon,
  cancelScan,
  t
}: {
  stats: DashboardStats;
  files: FileRecord[];
  selectedFolders: string[];
  isScanning: boolean;
  scanProgress: ScanProgressPayload | null;
  chooseFolders: () => Promise<void>;
  scanCommon: () => Promise<void>;
  cancelScan: () => Promise<void>;
  t: Translator;
}) {
  const scopedTotalSize = files.reduce((sum, file) => sum + file.size, 0);
  const diskUsageRatio = stats.diskTotalSize > 0 ? Math.min(1, scopedTotalSize / stats.diskTotalSize) : 0;
  const clutterItems = files.filter((file) => file.requires_confirmation || file.is_duplicate || file.size > 1024 * 1024 * 1024).length;
  const clutterRatio = files.length ? Math.min(1, clutterItems / files.length) : 0;
  const scopeLabel = selectedFolders[0] ?? t("userSpaceHint");
  const analysedSize = splitDisplaySize(formatBytes(scopedTotalSize));

  return (
    <div className={cn(pageSurface, "grid place-items-center gap-5 py-6 text-center")}>
      <section className="relative">
        <div
          className={cn(
            "grid h-72 w-72 place-items-center rounded-full p-4 shadow-[var(--shadow-strong)]",
            isScanning && "animate-pulse"
          )}
          style={{
            background: `conic-gradient(#3b82f6 0 ${Math.round(diskUsageRatio * 100)}%, rgba(59,130,246,0.10) ${Math.round(diskUsageRatio * 100)}% 100%)`
          } as CSSProperties}
        >
          <div className="grid h-full w-full place-items-center rounded-full border border-[var(--line)] bg-[var(--surface)] p-8 backdrop-blur-3xl">
            {isScanning ? (
              <div className="text-sm font-medium text-blue-600 dark:text-blue-300">
                <span>{t("scanning")}...</span>
              </div>
            ) : (
              <>
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--quiet)]">{t("totalAnalysed")}</span>
                <strong className="mt-2 block text-5xl font-semibold">
                  {analysedSize.value}
                  <span className="ml-1 text-base text-[var(--muted)]">{analysedSize.unit}</span>
                </strong>
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/40 px-3 py-1 text-sm text-[var(--muted)] dark:bg-white/5">
                  <i className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span>{percent(diskUsageRatio)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="grid w-full max-w-lg grid-cols-2 gap-3">
        <div className={cn(panelSurface, "p-4 text-left")}>
          <span className={quietText}>{t("files")}</span>
          <strong className="mt-1 block text-2xl text-blue-600 dark:text-blue-300">{stats.totalFiles.toLocaleString()}</strong>
        </div>
        <div className={cn(panelSurface, "p-4 text-left")}>
          <span className={quietText}>{t("clutterRatio")}</span>
          <strong className="mt-1 block text-2xl text-red-600 dark:text-red-300">{percent(clutterRatio)}</strong>
        </div>
      </section>

      <section className="flex items-center justify-center gap-3">
        <button className={glassButtonPrimary} onClick={scanCommon} disabled={isScanning}>
          <RefreshCw size={18} />
          <span>{isScanning ? t("scanning") : t("scanCommon")}</span>
        </button>
        {isScanning ? (
          <button className={glassButton} onClick={cancelScan}>
            <X size={18} />
            <span>{t("cancelScan")}</span>
          </button>
        ) : (
          <button className={glassButton} onClick={chooseFolders}>
            <FolderSearch size={18} />
            <span>{t("chooseFolders")}</span>
          </button>
        )}
      </section>

      <p className="max-w-xl text-sm font-medium text-[var(--ink)]">{scopeLabel}</p>
      <p className="max-w-2xl text-sm text-[var(--muted)]">
        {isScanning && scanProgress
          ? t("scanProgressLine")
              .replace("{files}", scanProgress.files.toLocaleString())
              .replace("{skipped}", scanProgress.skipped.toLocaleString())
              .replace("{path}", compactPath(scanProgress.root))
          : t("diskUsageInScope").replace("{size}", formatBytes(scopedTotalSize)).replace("{disk}", formatBytes(stats.diskTotalSize))}
      </p>
    </div>
  );
}

export function HubView({
  files,
  rules,
  onRunDispatch,
  onError,
  setView,
  t
}: {
  files: FileRecord[];
  rules: Rule[];
  onRunDispatch: () => Promise<RuleExecutionSummary | void>;
  onError: (message: string) => void;
  setView: (view: View) => void;
  t: Translator;
}) {
  const [isDispatching, setIsDispatching] = useState(false);
  const activeRuleCount = useMemo(() => rules.filter((rule) => rule.enabled).length, [rules]);
  const sortedFiles = useMemo(() => files.filter(isRuleClassified), [files]);
  const pendingFiles = useMemo(() => files.filter((file) => !isRuleClassified(file)), [files]);
  const buckets = useMemo(() => [
    { key: "CoreAssets" as const, label: t("coreAssets"), description: t("coreAssetsDesc"), tone: "blue" },
    { key: "QuietArchive" as const, label: t("archiveBox"), description: t("archiveBoxDesc"), tone: "purple" },
    { key: "CleanupLane" as const, label: t("cleanupLane"), description: t("cleanupLaneDesc"), tone: "slate" },
    { key: "PrivacyVault" as const, label: t("privacyVault"), description: t("privacyVaultDesc"), tone: "red" }
  ] satisfies Array<{ key: HubBucketKey; label: string; description: string; tone: string }>, [t]);
  const bucketedFiles = useMemo(() => groupFilesByHubBucket(sortedFiles), [sortedFiles]);

  async function runDispatch() {
    if (isDispatching || !files.length) return;
    setIsDispatching(true);
    try {
      await onRunDispatch();
      setIsDispatching(false);
      setView("preview");
    } catch {
      setIsDispatching(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(300px,0.8fr)_minmax(0,1.4fr)] gap-4 overflow-hidden">
      <section className={cn(panelSurface, "flex flex-col gap-4 overflow-hidden")}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t("inboxStack")}</h2>
          <span className={mutedText}>{pendingFiles.length} {t("items")}</span>
        </div>
        <VirtualFileCardList files={pendingFiles} onError={onError} t={t} />
        <motion.button
          whileTap={{ scale: 0.985 }}
          className={cn(glassButtonPrimary, "w-full")}
          onClick={runDispatch}
          disabled={isDispatching || !files.length}
          title={`${activeRuleCount} active rules`}
        >
          {isDispatching ? t("dispatching") : t("runDispatch")}
        </motion.button>
      </section>

      <motion.section className="grid min-h-0 grid-cols-2 gap-4 overflow-auto pr-1" variants={listMotion} initial="hidden" animate="show">
        {buckets.map((bucket) => {
          const bucketFiles = bucketedFiles[bucket.key];
          return (
            <motion.div
              className={cn(panelSurface, "flex min-h-[240px] flex-col gap-3", bucketFiles.length > 0 && "ring-1 ring-blue-400/20")}
              key={bucket.key}
              variants={itemMotion}
              layout
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">{bucket.label}</h3>
                  <small className={mutedText}>{bucket.description}</small>
                </div>
                <span className={cn("rounded-full border px-2 py-1 text-xs font-semibold", toneClasses(bucket.tone))}>{bucketFiles.length}</span>
              </div>
              <VirtualBucketFileList files={bucketFiles} setView={setView} waitingLabel={t("waitingFlow")} />
            </motion.div>
          );
        })}
      </motion.section>
    </div>
  );
}

function VirtualFileCardList({
  files,
  onError,
  t
}: {
  files: FileRecord[];
  onError: (message: string) => void;
  t: Translator;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = shouldVirtualizeList(files.length);
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => HUB_FILE_ROW_HEIGHT,
    overscan: 8
  });

  if (!files.length) {
    return (
      <div className="min-h-0 flex-1">
        <div className={cn(emptyState, "h-full")}>
          <Check size={24} />
          <span>{t("dispatchClear")}</span>
        </div>
      </div>
    );
  }

  if (!shouldVirtualize) {
    return (
      <motion.div className="grid min-h-0 flex-1 gap-3 overflow-auto pr-1" variants={listMotion} initial="hidden" animate="show">
        {files.map((file, index) => (
          <FileCard key={file.id} file={file} index={index} onError={onError} t={t} compact />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className={cn("min-h-0 flex-1", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index];
          return (
            <div
              className={virtualRowClass}
              key={file.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <FileCard file={file} index={virtualRow.index} onError={onError} t={t} compact disableAnimation />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VirtualBucketFileList({
  files,
  setView,
  waitingLabel
}: {
  files: FileRecord[];
  setView: (view: View) => void;
  waitingLabel: string;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = shouldVirtualizeList(files.length);
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => BUCKET_FILE_ROW_HEIGHT,
    overscan: 8
  });

  if (!files.length) {
    return (
      <div className={cn(emptyState, "min-h-32")}>
        <span>{waitingLabel}</span>
      </div>
    );
  }

  if (!shouldVirtualize) {
    return (
      <motion.div className="grid gap-2" variants={listMotion} initial="hidden" animate="show">
        {files.map((file) => (
          <BucketFileButton file={file} key={file.id} setView={setView} />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className={cn("min-h-32", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index];
          return (
            <div
              className={virtualRowClass}
              key={file.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <BucketFileButton file={file} setView={setView} disableAnimation />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BucketFileButton({
  file,
  setView,
  disableAnimation = false
}: {
  file: FileRecord;
  setView: (view: View) => void;
  disableAnimation?: boolean;
}) {
  return (
    <motion.button
      className={cn(compactRowSurface, "flex w-full items-center gap-2 overflow-hidden text-sm hover:bg-white/50 dark:hover:bg-white/10")}
      layout={!disableAnimation}
      variants={disableAnimation ? undefined : itemMotion}
      initial={disableAnimation ? false : undefined}
      animate={disableAnimation ? false : undefined}
      onClick={() => setView("preview")}
    >
      <File size={15} />
      <span className="truncate">{file.name}</span>
    </motion.button>
  );
}

function isRuleClassified(file: FileRecord): boolean {
  return file.classification_status === "classified";
}

export function VaultView({
  page,
  setPage,
  selectedFile,
  searchQuery,
  setSearchQuery,
  setSelectedFileId,
  onRefreshStats,
  onError,
  t
}: {
  page: FileQueryResult;
  setPage: (page: FileQueryResult | ((current: FileQueryResult) => FileQueryResult)) => void;
  selectedFile?: FileRecord;
  searchQuery: string;
  setSearchQuery: (searchQuery: string) => void;
  setSelectedFileId: (id: string) => void;
  onRefreshStats: () => Promise<void>;
  onError: (message: string) => void;
  t: Translator;
}) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const hasMore = page.files.length < page.total;

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError("");
    try {
      const next = await tauriApi.getPagedFiles(LIBRARY_PAGE_SIZE, offset, searchQuery);
      if (requestId !== requestIdRef.current) return;
      setPage((current) => append
        ? { ...next, files: [...current.files, ...next.files], offset: current.offset }
        : next
      );
      if (!append && next.files[0]) setSelectedFileId(next.files[0].id);
      await onRefreshStats();
    } catch (caught) {
      if (requestId === requestIdRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [onRefreshStats, searchQuery, setPage, setSelectedFileId]);

  useEffect(() => {
    void loadPage(0, false);
  }, [loadPage]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || isLoading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadPage(page.files.length, true);
      }
    }, { rootMargin: "320px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadPage, page.files.length]);

  const filters = [
    { key: "", label: t("libraryAllFiles"), description: t("libraryAllFilesDesc") },
    { key: "active", label: t("libraryActiveFiles"), description: t("libraryActiveFilesDesc") },
    { key: "archive", label: t("libraryArchiveFiles"), description: t("libraryArchiveFilesDesc") },
    { key: "review", label: t("libraryReviewFiles"), description: t("libraryReviewFilesDesc") }
  ];

  return (
    <div className={cn(pageSurface, "space-y-4")}>
      <div className="flex flex-wrap gap-2">
        {filters.map((filter) => (
          <button
            key={filter.label}
            className={segmentButton(searchQuery === filter.key)}
            onClick={() => setSearchQuery(filter.key)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {filters.map((filter) => (
          <span
            className={cn(
              "rounded-2xl border border-[var(--line)] bg-white/25 p-3 text-sm text-[var(--muted)] dark:bg-white/5",
              searchQuery === filter.key && "border-blue-400/50 bg-blue-500/10 text-[var(--ink)]"
            )}
            key={`${filter.key}-description`}
          >
            <strong className="mb-1 block text-[var(--ink)]">{filter.label}</strong>
            {filter.description}
          </span>
        ))}
      </div>
      <p className={mutedText}>{t("libraryIntro")}</p>
      <label className={cn(inputSurface, "flex items-center gap-2 px-3")}>
        <Search size={16} />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t("librarySearchPlaceholder")}
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      </label>
      <div className="flex items-center justify-between gap-3 text-sm text-[var(--muted)]">
        <span>{t("libraryShowing").replace("{visible}", String(page.files.length)).replace("{total}", String(page.total))}</span>
        {isLoading && <em className="not-italic">{t("loading")}</em>}
      </div>
      {error && <div className={cn(statusToast, "mt-0")}>{error}</div>}
      <VirtualAssetGrid
        files={page.files}
        onError={onError}
        selectedFileId={selectedFile?.id}
        setSelectedFileId={setSelectedFileId}
        t={t}
      />
      <div ref={sentinelRef} className="h-1" />
      {hasMore && (
        <button className={cn(glassButton, "mx-auto flex")} onClick={() => void loadPage(page.files.length, true)} disabled={isLoading}>
          <Plus size={16} />
          {t("loadMoreFiles").replace("{count}", String(Math.min(page.limit, page.total - page.files.length)))}
        </button>
      )}
    </div>
  );
}

function VirtualAssetGrid({
  files,
  onError,
  selectedFileId,
  setSelectedFileId,
  t
}: {
  files: FileRecord[];
  onError: (message: string) => void;
  selectedFileId?: string;
  setSelectedFileId: (id: string) => void;
  t: Translator;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(4);
  const shouldVirtualize = shouldVirtualizeList(files.length);
  const rowCount = Math.ceil(files.length / columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ASSET_GRID_ROW_HEIGHT,
    overscan: 4
  });

  useEffect(() => {
    const node = parentRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const nextColumns = Math.max(1, Math.min(4, Math.floor(width / 220)));
      setColumns(nextColumns || 1);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!shouldVirtualize) {
    return (
      <motion.section className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3" variants={listMotion} initial="hidden" animate="show">
        {files.map((file) => (
          <AssetCard
            file={file}
            isSelected={selectedFileId === file.id}
            key={file.id}
            onError={onError}
            setSelectedFileId={setSelectedFileId}
            t={t}
          />
        ))}
      </motion.section>
    );
  }

  return (
    <section ref={parentRef} className={cn("h-[calc(100vh-330px)] min-h-80", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const start = virtualRow.index * columns;
          const rowFiles = files.slice(start, start + columns);
          return (
            <div
              className="absolute left-0 top-0 grid w-full gap-3"
              key={virtualRow.key}
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              {rowFiles.map((file) => (
                <AssetCard
                  file={file}
                  isSelected={selectedFileId === file.id}
                  key={file.id}
                  onError={onError}
                  setSelectedFileId={setSelectedFileId}
                  t={t}
                />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

const AssetCard = memo(function AssetCard({
  file,
  isSelected,
  onError,
  setSelectedFileId,
  t
}: {
  file: FileRecord;
  isSelected: boolean;
  onError: (message: string) => void;
  setSelectedFileId: (id: string) => void;
  t: Translator;
}) {
  function selectFile() {
    setSelectedFileId(file.id);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    selectFile();
  }

  return (
    <motion.div
      className={cn(
        panelSurface,
        "group relative grid min-h-52 cursor-pointer gap-3 p-4 text-left transition hover:-translate-y-0.5 hover:bg-white/40 dark:hover:bg-white/10",
        isSelected && "ring-2 ring-blue-400/60"
      )}
      layout
      variants={itemMotion}
      role="button"
      tabIndex={0}
      onClick={selectFile}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] bg-white/70 text-[var(--muted)] opacity-0 shadow-sm transition hover:border-blue-400/60 hover:bg-blue-500/10 hover:text-blue-600 focus:opacity-100 group-hover:opacity-100 dark:bg-slate-900/70 dark:hover:text-blue-300"
        aria-label={t("revealPhysical")}
        title={t("revealPhysical")}
        onClick={(event) => {
          void revealFileFromCard({
            path: file.path,
            onError,
            stopPropagation: () => event.stopPropagation()
          });
        }}
      >
        <FolderOpen size={15} />
      </button>
      <div className={cn("grid h-12 w-12 place-items-center rounded-2xl border", toneClasses(file.risk_level === "Sensitive" ? "red" : file.lifecycle === "Archive" ? "purple" : "blue"))}>
        <File size={24} />
      </div>
      <h3 className="line-clamp-2 text-base font-semibold">{file.name}</h3>
      <div className="flex items-center justify-between gap-2 text-sm text-[var(--muted)]">
        <span>{file.lifecycle}</span>
        <strong>{formatBytes(file.size)}</strong>
      </div>
      <small className="truncate text-xs text-[var(--quiet)]">{file.directory || file.path}</small>
    </motion.div>
  );
});

export function TimelineView({
  previews,
  selectedIds,
  setSelectedIds,
  onRenamePreview,
  executeSelected,
  operationProgress,
  isOperationCanceling,
  cancelOperations,
  t
}: {
  previews: OperationPreview[];
  selectedIds: Set<string>;
  setSelectedIds: (ids: Set<string>) => void;
  onRenamePreview: (id: string, name: string) => void;
  executeSelected: () => Promise<void>;
  operationProgress: OperationProgressPayload | null;
  isOperationCanceling: boolean;
  cancelOperations: () => Promise<void>;
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
  const executeProgress = operationProgress?.kind === "execute" ? operationProgress : null;
  const isExecuting = Boolean(executeProgress);

  return (
    <div className={pageSurface}>
      <section className={panelSurface}>
        <div className={cn(sectionTitle, "items-center")}>
          <div>
            <h2>{t("suggestedPlan")}</h2>
            <p>{t("previewBeforeExecute")}</p>
          </div>
          <button className={glassButtonPrimary} onClick={executeSelected} disabled={!selectedIds.size || isExecuting}>
            <Play size={16} />
            <span>{isExecuting ? t("executingOperations") : t("executeSelected")} / {selectedIds.size}</span>
          </button>
        </div>
        <div className="mb-4 grid gap-2 text-sm text-[var(--muted)] sm:grid-cols-3">
          <span>{t("previewMainFolders")}: <strong>{groups.length}</strong></span>
          <span>{t("executableItems")}: <strong>{executableCount}</strong></span>
          <span>{t("blockedItems")}: <strong>{blockedCount}</strong></span>
        </div>
        {executeProgress && (
          <OperationProgressPanel
            progress={executeProgress}
            isCanceling={isOperationCanceling}
            onCancel={cancelOperations}
            t={t}
          />
        )}
        {!previews.length ? (
          <div className={emptyState}>{t("noOperations")}</div>
        ) : (
          <div className="grid gap-4">
            {groups.map((group) => {
              const executable = group.items.filter((item) => item.is_executable !== false);
              const allSelected = executable.length > 0 && executable.every((item) => selectedIds.has(item.id));
              return (
                <section className={cn(rowSurface, "grid gap-3 p-4")} key={group.key}>
                  <label className="grid cursor-pointer grid-cols-[auto_auto_minmax(0,1fr)_auto] items-center gap-3">
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
                      <strong className="block text-sm">{group.name}</strong>
                      <span className="block truncate text-xs text-[var(--muted)]">{group.path}</span>
                    </div>
                    <em className="rounded-full border border-[var(--line)] px-2 py-1 text-xs not-italic text-[var(--muted)]">{group.items.length}</em>
                  </label>
                  <div className="grid gap-3">
                    {group.subgroups.map((subgroup) => (
                      <section className="rounded-2xl border border-[var(--line-dark)] bg-white/20 p-3 dark:bg-white/5" key={`${group.key}-${subgroup.key}`}>
                        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 pb-2">
                          <Folder size={16} />
                          <div>
                            <strong className="block text-sm">{subgroup.name}</strong>
                            <span className="block truncate text-xs text-[var(--muted)]">{subgroup.path}</span>
                          </div>
                          <em className="text-xs not-italic text-[var(--muted)]">{subgroup.items.length}</em>
                        </div>
                        <VirtualPreviewFileRows
                          previews={subgroup.items}
                          selectedIds={selectedIds}
                          toggle={toggle}
                          onRenamePreview={onRenamePreview}
                          t={t}
                        />
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

function VirtualPreviewFileRows({
  previews,
  selectedIds,
  toggle,
  onRenamePreview,
  t
}: {
  previews: OperationPreview[];
  selectedIds: Set<string>;
  toggle: (id: string) => void;
  onRenamePreview: (id: string, name: string) => void;
  t: Translator;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = shouldVirtualizeList(previews.length);
  const rowVirtualizer = useVirtualizer({
    count: previews.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => PREVIEW_ROW_HEIGHT,
    overscan: 6
  });

  if (!shouldVirtualize) {
    return (
      <motion.div className="grid gap-2" variants={listMotion} initial="hidden" animate="show">
        {previews.map((preview) => (
          <PreviewFileRow
            key={preview.id}
            preview={preview}
            isSelected={selectedIds.has(preview.id)}
            toggle={toggle}
            onRenamePreview={onRenamePreview}
            t={t}
          />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className={cn("max-h-96", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const preview = previews[virtualRow.index];
          return (
            <div
              className={virtualRowClass}
              key={preview.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <PreviewFileRow
                preview={preview}
                isSelected={selectedIds.has(preview.id)}
                toggle={toggle}
                onRenamePreview={onRenamePreview}
                t={t}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const PreviewFileRow = memo(function PreviewFileRow({
  preview,
  isSelected,
  toggle,
  onRenamePreview,
  t
}: {
  preview: OperationPreview;
  isSelected: boolean;
  toggle: (id: string) => void;
  onRenamePreview: (id: string, name: string) => void;
  t: Translator;
}) {
  return (
    <motion.div className={cn(compactRowSurface, "grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-3")} layout variants={itemMotion}>
      <input
        type="checkbox"
        disabled={preview.is_executable === false}
        checked={isSelected}
        onChange={() => toggle(preview.id)}
      />
      <File size={15} />
      <div className="min-w-0">
        <strong className="block truncate text-sm">{preview.old_name}</strong>
        <span className="block text-xs text-[var(--muted)]">{preview.operation_type} / {percent(preview.confidence)}</span>
        <code className="mt-1 block truncate rounded bg-slate-500/10 px-2 py-1 text-[11px] text-[var(--muted)]" title={preview.source_path}>{preview.source_path}</code>
        <code className="mt-1 block truncate rounded bg-blue-500/10 px-2 py-1 text-[11px] text-blue-600 dark:text-blue-300" title={preview.target_path}>{preview.target_path}</code>
        <input
          className={cn(inputSurface, "mt-2 w-full")}
          value={preview.new_name}
          disabled={!preview.editable_new_name || preview.is_executable === false}
          onChange={(event) => onRenamePreview(preview.id, event.target.value)}
          aria-label={t("newFileName")}
        />
      </div>
    </motion.div>
  );
});

export function RulesView({
  rules,
  onSave,
  onToggleRuleEnabled,
  onDeleteRule,
  t
}: {
  rules: Rule[];
  onSave: (rule: Rule) => Promise<void>;
  onToggleRuleEnabled?: (rule: Rule, enabled: boolean) => Promise<void> | void;
  onDeleteRule?: (rule: Rule) => Promise<void> | void;
  t: Translator;
}) {
  const [name, setName] = useState("Screenshots to Inbox");
  const [rootOperator, setRootOperator] = useState<RuleOperator>("AND");
  const [groups, setGroups] = useState<RuleConditionGroup[]>(() => [createRuleGroup()]);
  const [purpose, setPurpose] = useState<Purpose>("Temporary");
  const [lifecycle, setLifecycle] = useState<Lifecycle>("Inbox");
  const [weight, setWeight] = useState(76);

  function updateGroupOperator(groupId: string, nextOperator: RuleOperator) {
    setGroups((current) =>
      current.map((group) => (group.id === groupId ? { ...group, operator: nextOperator } : group))
    );
  }

  function updateCondition(groupId: string, conditionId: string, patch: Partial<RuleCondition>) {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId
          ? {
              ...group,
              conditions: group.conditions.map((condition) =>
                condition.id === conditionId ? { ...condition, ...patch } : condition
              )
            }
          : group
      )
    );
  }

  function addCondition(groupId: string) {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId
          ? { ...group, conditions: [...group.conditions, createRuleCondition({ value: "" })] }
          : group
      )
    );
  }

  function removeCondition(groupId: string, conditionId: string) {
    setGroups((current) =>
      current.map((group) =>
        group.id === groupId && group.conditions.length > 1
          ? { ...group, conditions: group.conditions.filter((condition) => condition.id !== conditionId) }
          : group
      )
    );
  }

  function addGroup() {
    setGroups((current) => [...current, createRuleGroup({ value: "" })]);
  }

  function removeGroup(groupId: string) {
    setGroups((current) =>
      current.length > 1 ? current.filter((group) => group.id !== groupId) : current
    );
  }

  async function submit() {
    const now = nowIso();
    await onSave(buildRuleFromBuilderDraft({
      name,
      rootOperator,
      groups,
      purpose,
      lifecycle,
      weight,
      now
    }));
  }

  return (
    <div className={cn(pageSurface, "grid grid-cols-[minmax(360px,0.9fr)_minmax(0,1.1fr)] gap-4 overflow-hidden")}>
      <section className={panelSurface}>
        <SectionTitle title={t("ruleBuilder")} body={t("customDesc")} />
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--line)] bg-white/25 p-3 text-sm dark:bg-white/5">
          <span>{t("whenFile")}</span>
          <strong className="rounded-full bg-blue-500/10 px-2 py-1 text-blue-600 dark:text-blue-300">{groups.length} {t("ruleGroups")}</strong>
          <strong className="rounded-full bg-emerald-500/10 px-2 py-1 text-emerald-600 dark:text-emerald-300">{rootOperator}</strong>
          <span>{t("thenSendTo")}</span>
          <strong className="rounded-full bg-violet-500/10 px-2 py-1 text-violet-600 dark:text-violet-300">{purpose}</strong>
        </div>
        <div className={formGrid}>
          <label>{t("ruleName")}<input className={inputSurface} value={name} onChange={(event) => setName(event.target.value)} /></label>
          <div className="grid gap-1.5 text-sm font-medium text-[var(--muted)]">
            <span>{t("rootOperator")}</span>
            <div className={segmented} role="group" aria-label={t("rootOperator")}>
              {RULE_LOGIC_OPTIONS.map((item) => (
                <button key={item} type="button" className={segmentButton(rootOperator === item)} onClick={() => setRootOperator(item)}>
                  {item}
                </button>
              ))}
            </div>
          </div>
          <label>{t("purpose")}<select className={selectSurface} value={purpose} onChange={(event) => setPurpose(event.target.value as Purpose)}>{RULE_PURPOSE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>{t("lifecycle")}<select className={selectSurface} value={lifecycle} onChange={(event) => setLifecycle(event.target.value as Lifecycle)}>{RULE_LIFECYCLE_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>
          <label>{t("weight")}<input className={inputSurface} type="number" value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></label>
        </div>
        <div className="mt-4 grid gap-3">
          {groups.map((group, groupIndex) => (
            <div key={group.id} className="rounded-2xl border border-[var(--line)] bg-white/25 p-3 shadow-sm dark:bg-white/5">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <strong className="block text-sm">{t("ruleGroup")} {groupIndex + 1}</strong>
                  <span className={quietText}>{group.conditions.length} {t("conditions")}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={quietText}>{t("groupOperator")}</span>
                  <div className={segmented} role="group" aria-label={`${t("ruleGroup")} ${groupIndex + 1} ${t("groupOperator")}`}>
                    {RULE_LOGIC_OPTIONS.map((item) => (
                      <button key={item} type="button" className={segmentButton(group.operator === item)} onClick={() => updateGroupOperator(group.id, item)}>
                        {item}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] transition hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent disabled:hover:text-[var(--muted)] dark:hover:text-red-300"
                    disabled={groups.length <= 1}
                    aria-label={t("deleteGroup")}
                    title={t("deleteGroup")}
                    onClick={() => removeGroup(group.id)}
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
              <div className="grid gap-2">
                {group.conditions.map((condition) => (
                  <div key={condition.id} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)_auto] items-center gap-2">
                    <select
                      className={selectSurface}
                      value={condition.field}
                      aria-label={t("field")}
                      onChange={(event) => updateCondition(group.id, condition.id, { field: event.target.value as RuleCondition["field"] })}
                    >
                      {RULE_FIELD_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                    <select
                      className={selectSurface}
                      value={condition.operator}
                      aria-label={t("operator")}
                      onChange={(event) => updateCondition(group.id, condition.id, { operator: event.target.value as RuleCondition["operator"] })}
                    >
                      {RULE_OPERATOR_OPTIONS.map((item) => <option key={item} value={item}>{item}</option>)}
                    </select>
                    <input
                      className={inputSurface}
                      value={String(condition.value)}
                      aria-label={t("value")}
                      onChange={(event) => updateCondition(group.id, condition.id, { value: event.target.value })}
                    />
                    <button
                      type="button"
                      className="grid h-10 w-10 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] transition hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent disabled:hover:text-[var(--muted)] dark:hover:text-red-300"
                      disabled={group.conditions.length <= 1}
                      aria-label={t("deleteCondition")}
                      title={t("deleteCondition")}
                      onClick={() => removeCondition(group.id, condition.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className={cn(glassButton, "mt-3")} onClick={() => addCondition(group.id)}>
                <Plus size={15} />
                {t("addCondition")}
              </button>
            </div>
          ))}
          <button type="button" className={glassButton} onClick={addGroup}>
            <Plus size={15} />
            {t("addGroup")}
          </button>
        </div>
        <button className={cn(glassButtonPrimary, "mt-4")} onClick={submit}>
          <Plus size={17} />
          {t("saveRule")}
        </button>
      </section>

      <section className={cn(panelSurface, "overflow-hidden")}>
        <SectionTitle title={t("strategy")} body={t("ruleLayerDesc")} />
        <VirtualRuleList
          rules={rules}
          onToggleRuleEnabled={onToggleRuleEnabled}
          onDeleteRule={onDeleteRule}
          t={t}
        />
      </section>
    </div>
  );
}

function VirtualRuleList({
  rules,
  onToggleRuleEnabled,
  onDeleteRule,
  t
}: {
  rules: Rule[];
  onToggleRuleEnabled?: (rule: Rule, enabled: boolean) => Promise<void> | void;
  onDeleteRule?: (rule: Rule) => Promise<void> | void;
  t: Translator;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = shouldVirtualizeList(rules.length);
  const rowVirtualizer = useVirtualizer({
    count: rules.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => RULE_ROW_HEIGHT,
    overscan: 8
  });

  if (!shouldVirtualize) {
    return (
      <motion.div className="grid gap-2" variants={listMotion} initial="hidden" animate="show">
        {rules.map((rule) => (
          <RuleRow
            key={rule.id}
            rule={rule}
            onToggleEnabled={onToggleRuleEnabled}
            onDeleteRule={onDeleteRule}
            t={t}
          />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className={cn("h-[calc(100vh-260px)]", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const rule = rules[virtualRow.index];
          return (
            <div
              className={virtualRowClass}
              key={rule.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <RuleRow
                rule={rule}
                onToggleEnabled={onToggleRuleEnabled}
                onDeleteRule={onDeleteRule}
                t={t}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RuleRow = memo(function RuleRow({
  rule,
  onToggleEnabled,
  onDeleteRule,
  t
}: {
  rule: Rule;
  onToggleEnabled?: (rule: Rule, enabled: boolean) => Promise<void> | void;
  onDeleteRule?: (rule: Rule) => Promise<void> | void;
  t: Translator;
}) {
  const canToggle = rule.source === "user" && Boolean(onToggleEnabled);
  const canDelete = rule.source === "user" && Boolean(onDeleteRule);
  const toggleLabel = canToggle
    ? rule.enabled
      ? t("disableRule")
      : t("enableRule")
    : t("systemRuleLocked");
  const deleteLabel = canDelete ? t("deleteRule") : t("systemRuleCannotDelete");

  return (
    <motion.div className={cn(compactRowSurface, "grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-3")} layout variants={itemMotion}>
      <div>
        <strong className="block truncate text-sm">{rule.name}</strong>
        <span className="block text-xs text-[var(--muted)]">{rule.source} / weight {rule.weight} / priority {rule.priority}</span>
      </div>
      <span className={sourceBadge(rule.source)}>{rule.source}</span>
      <button
        type="button"
        className={toggleSwitch(rule.enabled)}
        disabled={!canToggle}
        aria-pressed={rule.enabled}
        aria-label={toggleLabel}
        title={toggleLabel}
        onClick={(event) => {
          event.stopPropagation();
          if (!canToggle) return;
          void onToggleEnabled?.(rule, !rule.enabled);
        }}
      >
        <i />
      </button>
      <button
        type="button"
        className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] text-[var(--muted)] transition hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-[var(--line)] disabled:hover:bg-transparent disabled:hover:text-[var(--muted)] dark:hover:text-red-300"
        disabled={!canDelete}
        aria-label={deleteLabel}
        title={deleteLabel}
        onClick={(event) => {
          event.stopPropagation();
          if (!canDelete || !window.confirm(t("confirmDeleteRule"))) return;
          void onDeleteRule?.(rule);
        }}
      >
        <Trash2 size={15} />
      </button>
    </motion.div>
  );
});

export function RestoreView({
  logs,
  onRestore,
  operationProgress,
  isOperationCanceling,
  cancelOperations,
  t
}: {
  logs: OperationLog[];
  onRestore: (logs: OperationLog[]) => Promise<void>;
  operationProgress: OperationProgressPayload | null;
  isOperationCanceling: boolean;
  cancelOperations: () => Promise<void>;
  t: Translator;
}) {
  const [selectedBatchId, setSelectedBatchId] = useState("");
  const batches = useMemo(() => groupOperationLogs(logs), [logs]);
  const selectedBatch = batches.find((batch) => batch.batchId === selectedBatchId) ?? batches[0];
  const restorableLogs = selectedBatch?.logs.filter(isRestorableLog) ?? [];
  const restoreProgress = operationProgress?.kind === "restore" ? operationProgress : null;
  const isRestoring = Boolean(restoreProgress);
  const historyLogs = useMemo(
    () => [...logs].sort((a, b) => logTimeValue(b.created_at) - logTimeValue(a.created_at)).slice(0, 8),
    [logs]
  );

  useEffect(() => {
    if (!batches.length) {
      setSelectedBatchId("");
      return;
    }
    if (!selectedBatchId || !batches.some((batch) => batch.batchId === selectedBatchId)) {
      setSelectedBatchId(batches[0].batchId);
    }
  }, [batches, selectedBatchId]);

  async function restoreSelectedBatch() {
    if (!restorableLogs.length || isRestoring) return;
    await onRestore(restorableLogs);
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)] gap-4 overflow-hidden">
      <section className={cn(panelSurface, "overflow-auto")}>
        <SectionTitle title={t("restoreRecords")} body={t("restoreDesc")} />
        {batches.length ? (
          <div className="grid gap-2">
            {batches.map((batch) => (
              <button
                className={cn(
                  rowSurface,
                  "w-full",
                  batch.batchId === selectedBatch?.batchId && "border-blue-400/60 bg-blue-500/10"
                )}
                key={batch.batchId}
                onClick={() => setSelectedBatchId(batch.batchId)}
              >
                <div className="mb-2 flex items-center gap-2 text-sm">
                  <RotateCcw size={16} />
                  <strong>{formatLogDate(batch.createdAt)}</strong>
                </div>
                <div>
                  <strong className="block text-sm">{batch.total} {t("items")} / {batch.restorable} {t("restorable")}</strong>
                  <small className={mutedText}>
                    {t("success")}: {batch.success} · {t("failed")}: {batch.failed} · {t("restored")}: {batch.restored}
                  </small>
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className={emptyState}>{t("noRestoreRecords")}</div>
        )}
        <div className="my-5 h-px bg-[var(--line-dark)]" />
        <SectionTitle title={t("operationHistory")} body={t("timeMachineDesc")} />
        {historyLogs.length ? (
          <div className="grid gap-2">
            {historyLogs.map((log) => (
              <div className={cn(compactRowSurface, "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3")} key={log.id}>
                <span className={cn("h-2.5 w-2.5 rounded-full", log.status === "success" ? "bg-emerald-500" : "bg-red-500")} />
                <div>
                  <strong className="block truncate text-sm">{log.new_name || log.old_name}</strong>
                  <span className="block text-xs text-[var(--muted)]">{log.operation_type} · {formatLogDate(log.created_at)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className={cn(emptyState, "min-h-20")}>{t("noOperationHistory")}</div>
        )}
      </section>

      <section className={cn(panelSurface, "overflow-auto")}>
        <div className={cn(sectionTitle, "items-center")}>
          <div>
            <h2>{t("restorePreview")}</h2>
            <p>{t("restorePreviewDesc")}</p>
          </div>
          <button
            className={glassButtonPrimary}
            disabled={!restorableLogs.length || isRestoring}
            onClick={restoreSelectedBatch}
          >
            <RotateCcw size={16} />
            {isRestoring ? t("restoring") : t("restoreBatch")}
          </button>
        </div>
        {restoreProgress && (
          <OperationProgressPanel
            progress={restoreProgress}
            isCanceling={isOperationCanceling}
            onCancel={cancelOperations}
            t={t}
          />
        )}
        {selectedBatch ? (
          <div className="grid gap-2">
            {selectedBatch.logs.map((log) => {
              const isRestorable = isRestorableLog(log);
              return (
                <div className={cn(rowSurface, isRestorable ? "border-emerald-400/40 bg-emerald-500/10" : "border-slate-400/20 opacity-80")} key={log.id}>
                  <div className="mb-2 flex items-center gap-2 text-sm">
                    {isRestorable ? <Check size={15} /> : <X size={15} />}
                    <strong>{restoreStatusLabel(log, t)}</strong>
                  </div>
                  <div>
                    <strong className="block truncate text-sm">{log.new_name || log.old_name}</strong>
                    <div className="mt-2 flex min-w-0 items-center gap-2 text-xs text-[var(--muted)]">
                      <span title={log.path_after}>{compactPath(log.path_after, 48)}</span>
                      <ChevronRight size={14} />
                      <span title={log.path_before}>{compactPath(log.path_before, 48)}</span>
                    </div>
                    {(log.restore_error || log.error_message) && (
                      <small className="mt-2 block text-xs text-red-500">{log.restore_error || log.error_message}</small>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <div className={cn(emptyState, "min-h-20")}>{t("noRestorePreview")}</div>
        )}
      </section>
    </div>
  );
}

interface OperationLogBatch {
  batchId: string;
  createdAt: string;
  logs: OperationLog[];
  total: number;
  success: number;
  failed: number;
  restored: number;
  restorable: number;
}

function groupOperationLogs(logs: OperationLog[]): OperationLogBatch[] {
  const groups = new Map<string, OperationLog[]>();
  for (const log of logs) {
    const key = log.batch_id || "batch";
    const group = groups.get(key) ?? [];
    group.push(log);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([batchId, batchLogs]) => {
      const sortedLogs = [...batchLogs].sort((a, b) => logTimeValue(b.created_at) - logTimeValue(a.created_at));
      return {
        batchId,
        createdAt: sortedLogs[0]?.created_at ?? "",
        logs: sortedLogs,
        total: sortedLogs.length,
        success: sortedLogs.filter((log) => log.status === "success").length,
        failed: sortedLogs.filter((log) => log.status === "failed").length,
        restored: sortedLogs.filter((log) => log.restore_status === "restored").length,
        restorable: sortedLogs.filter(isRestorableLog).length
      };
    })
    .sort((a, b) => logTimeValue(b.createdAt) - logTimeValue(a.createdAt));
}

function isRestorableLog(log: OperationLog): boolean {
  return (
    log.status === "success" &&
    log.can_restore &&
    (log.restore_status === "not_restored" || log.restore_status === "failed" || log.restore_status === "canceled")
  );
}

function restoreStatusLabel(log: OperationLog, t: Translator): string {
  if (log.restore_status === "restored") return t("restored");
  if (log.restore_status === "failed") return t("failed");
  if (log.restore_status === "canceled") return t("operationCanceled");
  if (isRestorableLog(log)) return t("restorable");
  if (log.status === "skipped") return t("skipped");
  return t("unavailable");
}

function formatLogDate(value: string): string {
  const timestamp = logTimeValue(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "-";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function logTimeValue(value: string): number {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function SettingsView({
  language,
  setLanguage,
  theme,
  setTheme,
  platform,
  closeBehavior,
  setCloseBehavior,
  folderNamingLanguage,
  setFolderNamingLanguage,
  defaultScanFolders,
  setDefaultScanFolders,
  restoreRetentionDays,
  setRestoreRetentionDays,
  launchAtLogin,
  setLaunchAtLogin,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  platform: NodeJS.Platform | "browser";
  closeBehavior: CloseBehavior;
  setCloseBehavior: (behavior: CloseBehavior) => Promise<boolean>;
  folderNamingLanguage: FolderNamingLanguage;
  setFolderNamingLanguage: (language: FolderNamingLanguage) => Promise<boolean>;
  defaultScanFolders: DefaultScanFolder[];
  setDefaultScanFolders: (folders: DefaultScanFolder[]) => Promise<boolean>;
  restoreRetentionDays: RestoreRetentionDays;
  setRestoreRetentionDays: (days: RestoreRetentionDays) => Promise<boolean>;
  launchAtLogin: boolean;
  setLaunchAtLogin: (enabled: boolean) => Promise<boolean>;
  t: Translator;
}) {
  const hotkey = defaultPlatformAccelerator(platform);
  const [settingsStatus, setSettingsStatus] = useState("");

  async function updateCloseBehavior(next: CloseBehavior) {
    const saved = await setCloseBehavior(next);
    if (saved) {
      setSettingsStatus(t("settingSaved"));
    }
  }

  async function updateFolderNamingLanguage(next: FolderNamingLanguage) {
    const saved = await setFolderNamingLanguage(next);
    if (saved) {
      setSettingsStatus(t("settingSaved"));
    }
  }

  async function updateLaunchAtLogin(next: boolean) {
    const saved = await setLaunchAtLogin(next);
    if (saved) {
      setSettingsStatus(t("settingSaved"));
    }
  }

  async function toggleDefaultScanFolder(folder: DefaultScanFolder) {
    const saved = await setDefaultScanFolders(nextDefaultScanFolders(defaultScanFolders, folder));
    if (saved) {
      setSettingsStatus(`${t("settingSaved")} · ${t("defaultScanFoldersRestartHint")}`);
    }
  }

  async function updateRestoreRetentionDays(next: RestoreRetentionDays) {
    const saved = await setRestoreRetentionDays(next);
    if (saved) {
      setSettingsStatus(t("settingSaved"));
    }
  }

  return (
    <div className={cn(pageSurface, "grid grid-cols-[minmax(0,1fr)_minmax(300px,0.7fr)] gap-4 overflow-hidden")}>
      <section className={cn(panelSurface, "overflow-auto")}>
        <SectionTitle title={t("settings")} body={t("settingsDesc")} />
        <div className="grid gap-3">
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("language")}</strong><span className={mutedText}>{t("languageDesc")}</span></div>
          <div className={segmented}>
            <button className={segmentButton(language === "zh")} onClick={() => setLanguage("zh")}>中文</button>
            <button className={segmentButton(language === "en")} onClick={() => setLanguage("en")}>English</button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("appearance")}</strong><span className={mutedText}>{t("appearanceDesc")}</span></div>
          <div className={segmented}>
            <button className={segmentButton(theme === "light")} onClick={() => setTheme("light")}>{t("lightTheme")}</button>
            <button className={segmentButton(theme === "dark")} onClick={() => setTheme("dark")}>{t("darkTheme")}</button>
            <button className={segmentButton(theme === "system")} onClick={() => setTheme("system")}>{t("systemTheme")}</button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("folderNaming")}</strong><span className={mutedText}>{t("folderNamingDesc")}</span></div>
          <div className={segmented}>
            <button className={segmentButton(folderNamingLanguage === "en")} onClick={() => void updateFolderNamingLanguage("en")}>{t("englishFolderNames")}</button>
            <button className={segmentButton(folderNamingLanguage === "zh")} onClick={() => void updateFolderNamingLanguage("zh")}>{t("chineseFolderNames")}</button>
          </div>
        </div>
        <div className="grid gap-3 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("defaultScanFolders")}</strong><span className={mutedText}>{t("defaultScanFoldersDesc")}</span></div>
          <div className="flex flex-wrap gap-2">
            {(["Desktop", "Downloads", "Documents"] as DefaultScanFolder[]).map((folder) => (
              <button className={segmentButton(defaultScanFolders.includes(folder))} key={folder} onClick={() => void toggleDefaultScanFolder(folder)}>
                {folder}
              </button>
            ))}
          </div>
          <span className={quietText}>{t("defaultScanFoldersRestartHint")}</span>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("searchHotkey")}</strong><span className={mutedText}>{t("searchHotkeyDesc")}</span></div>
          <span className="rounded-xl border border-[var(--line)] bg-white/25 px-3 py-1.5 text-sm font-medium text-[var(--ink)] dark:bg-white/5">{hotkey}</span>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("launchAtLogin")}</strong><span className={mutedText}>{t("launchAtLoginDesc")}</span></div>
          <button className={toggleSwitch(launchAtLogin)} onClick={() => void updateLaunchAtLogin(!launchAtLogin)}><i /></button>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("closeBehavior")}</strong><span className={mutedText}>{t("closeBehaviorDesc")}</span></div>
          <div className={segmented}>
            <button className={segmentButton(closeBehavior === "ask")} onClick={() => void updateCloseBehavior("ask")}>{t("askEveryTime")}</button>
            <button className={segmentButton(closeBehavior === "minimize")} onClick={() => void updateCloseBehavior("minimize")}>{t("minimizeToTray")}</button>
            <button className={segmentButton(closeBehavior === "quit")} onClick={() => void updateCloseBehavior("quit")}>{t("quitApp")}</button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("logRetention")}</strong><span className={mutedText}>{t("logRetentionDesc")}</span></div>
          <div className={segmented}>
            {([15, 30, 60, 90] as RestoreRetentionDays[]).map((days) => (
              <button className={segmentButton(restoreRetentionDays === days)} key={days} onClick={() => void updateRestoreRetentionDays(days)}>
                {days} {t("days")}
              </button>
            ))}
          </div>
        </div>
        </div>
        {settingsStatus && <div className={cn(statusToast, "mt-4")}>{settingsStatus}</div>}
      </section>

      <section className={panelSurface}>
        <SectionTitle title={t("releaseReady")} body={t("releaseReadyDesc")} />
        <div className="grid gap-3">
        <div className="flex items-center justify-between gap-4 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("searchSources")}</strong><span className={mutedText}>{t("searchSourcesDesc")}</span></div>
          <span className={sourceBadge("user_space")}>{t("localOnly")}</span>
        </div>
        <div className="rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div><strong className="block text-sm">{t("excludedDirs")}</strong><span className={mutedText}>node_modules, .git, target, dist, build</span></div>
        </div>
        </div>
      </section>
    </div>
  );
}

function FileCard({
  file,
  index,
  onError,
  t,
  compact = false,
  disableAnimation = false
}: {
  file: FileRecord;
  index: number;
  onError: (message: string) => void;
  t: Translator;
  compact?: boolean;
  disableAnimation?: boolean;
}) {
  return (
    <motion.div
      className={cn(
        rowSurface,
        "group grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 hover:bg-white/50 dark:hover:bg-white/10",
        compact ? "p-3" : "p-4"
      )}
      layout={!disableAnimation}
      variants={disableAnimation ? undefined : itemMotion}
      initial={disableAnimation ? false : undefined}
      animate={disableAnimation ? false : undefined}
      style={{ "--delay": `${Math.min(index * 18, 320)}ms` } as CSSProperties}
    >
      <File size={18} />
      <span className="min-w-0">
        <strong className="block truncate text-sm">{file.name}</strong>
        <small className="block text-xs text-[var(--muted)]">{file.purpose} / {formatBytes(file.size)}</small>
      </span>
      <button
        type="button"
        className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] bg-white/60 text-[var(--muted)] opacity-0 shadow-sm transition hover:border-blue-400/60 hover:bg-blue-500/10 hover:text-blue-600 focus:opacity-100 group-hover:opacity-100 dark:bg-slate-900/60 dark:hover:text-blue-300"
        aria-label={t("revealPhysical")}
        title={t("revealPhysical")}
        onClick={(event) => {
          void revealFileFromCard({
            path: file.path,
            onError,
            stopPropagation: () => event.stopPropagation()
          });
        }}
      >
        <FolderOpen size={15} />
      </button>
      <em className={cn("rounded-full border px-2 py-1 text-xs not-italic", toneClasses(file.risk_level === "Sensitive" ? "red" : "green"))}>{file.risk_level === "Sensitive" ? t("sensitiveLabel") : t("normal")}</em>
    </motion.div>
  );
}

function OperationProgressPanel({
  progress,
  isCanceling,
  onCancel,
  t
}: {
  progress: OperationProgressPayload;
  isCanceling: boolean;
  onCancel: () => Promise<void>;
  t: Translator;
}) {
  const ratio = progress.total > 0 ? Math.min(1, progress.processed / progress.total) : 0;
  const currentPath = progress.currentPath ? compactPath(progress.currentPath, 56) : "-";
  const line = t("operationProgressLine")
    .replace("{processed}", progress.processed.toLocaleString())
    .replace("{total}", progress.total.toLocaleString())
    .replace("{path}", currentPath);

  return (
    <div className={cn(rowSurface, "mb-4 grid gap-3 p-4")}>
      <div className="flex items-center justify-between gap-3 text-sm">
        <strong>{progress.kind === "restore" ? t("restoring") : t("executingOperations")}</strong>
        <span className="text-[var(--muted)]">
          {progress.processed.toLocaleString()} / {progress.total.toLocaleString()}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-white/50 dark:bg-white/10">
        <div
          className="h-full rounded-full bg-blue-500 transition-[width]"
          style={{ width: `${Math.round(ratio * 100)}%` }}
        />
      </div>
      <div className="flex min-w-0 items-center justify-between gap-3">
        <small className="min-w-0 truncate text-xs text-[var(--muted)]">{line}</small>
        <button className={glassButton} onClick={onCancel} disabled={isCanceling}>
          <X size={15} />
          <span>{isCanceling ? t("operationCanceling") : t("cancel")}</span>
        </button>
      </div>
    </div>
  );
}

function SectionTitle({ title, body }: { title: string; body: string }) {
  return (
    <div className={sectionTitle}>
      <div>
        <h2>{title}</h2>
        <p>{body}</p>
      </div>
    </div>
  );
}
