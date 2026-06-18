import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion, type Variants } from "motion/react";
import { Check, ChevronRight, File, Folder, FolderSearch, Play, Plus, RefreshCw, RotateCcw, Search, X } from "lucide-react";
import { tauriApi, type RuleExecutionSummary, type ScanProgressPayload } from "../api/tauriApi";
import type { Language } from "../i18n";
import type {
  CloseBehavior,
  DashboardStats,
  DefaultScanFolder,
  FileQueryResult,
  FileRecord,
  FolderNamingLanguage,
  OperationPreview,
  RestoreRetentionDays,
  Rule
} from "../types/domain";
import type { ThemeMode, Translator, View } from "../types/ui";
import { formatBytes, formatDate, percent } from "../utils/format";
import {
  compactPath,
  defaultPlatformAccelerator,
  groupOperationPreviews,
  localId,
  nowIso,
  splitDisplaySize
} from "../utils/viewHelpers";
import { shouldVirtualizeList } from "../utils/virtualization";

const LIBRARY_PAGE_SIZE = 50;
const HUB_FILE_ROW_HEIGHT = 82;
const BUCKET_FILE_ROW_HEIGHT = 48;
const ASSET_GRID_ROW_HEIGHT = 234;
const PREVIEW_ROW_HEIGHT = 156;
const RULE_ROW_HEIGHT = 68;

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
  const scopeLabel = selectedFolders.length
    ? selectedFolders.length === 1
      ? selectedFolders[0]
      : `${selectedFolders.length} ${t("foldersSelected")}`
    : t("userSpaceHint");
  const analysedSize = splitDisplaySize(formatBytes(scopedTotalSize));

  return (
    <div className="scanner-stage scanner-demo-stage page-enter">
      <section className="scanner-demo-radar-wrap">
        <div
          className={`radar-chart ${isScanning ? "is-running scanner-glow" : ""}`}
          style={{ "--scan-percent": `${Math.round(diskUsageRatio * 100)}%` } as React.CSSProperties}
        >
          <div className="radar-inner">
            {isScanning ? (
              <div className="scanner-pulse-state">
                <span>{t("scanning")}...</span>
              </div>
            ) : (
              <>
                <span className="scanner-kicker">{t("totalAnalysed")}</span>
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
        <div className="metric-card blue">
          <span>{t("files")}</span>
          <strong>{stats.totalFiles.toLocaleString()}</strong>
        </div>
        <div className="metric-card red">
          <span>{t("clutterRatio")}</span>
          <strong>{percent(clutterRatio)}</strong>
        </div>
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
  setView,
  t
}: {
  files: FileRecord[];
  rules: Rule[];
  onRunDispatch: () => Promise<RuleExecutionSummary | void>;
  setView: (view: View) => void;
  t: Translator;
}) {
  const [isDispatching, setIsDispatching] = useState(false);
  const activeRuleCount = useMemo(() => rules.filter((rule) => rule.enabled).length, [rules]);
  const sortedFiles = useMemo(() => files.filter(isRuleClassified), [files]);
  const pendingFiles = useMemo(() => files.filter((file) => !isRuleClassified(file)), [files]);
  const buckets = useMemo(() => [
    { key: "CoreAssets", label: t("coreAssets"), description: t("coreAssetsDesc"), tone: "blue" },
    { key: "QuietArchive", label: t("archiveBox"), description: t("archiveBoxDesc"), tone: "purple" },
    { key: "CleanupLane", label: t("cleanupLane"), description: t("cleanupLaneDesc"), tone: "slate" },
    { key: "PrivacyVault", label: t("privacyVault"), description: t("privacyVaultDesc"), tone: "red" }
  ], [t]);

  function fileBucket(file: FileRecord) {
    if (file.risk_level === "Sensitive") return "PrivacyVault";
    if (file.lifecycle === "Archive") return "QuietArchive";
    if (file.suggested_action === "DeleteCandidate" || file.suggested_action === "Review") return "CleanupLane";
    return "CoreAssets";
  }

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
    <div className="hub-layout page-enter">
      <section className="glass-panel hub-inbox">
        <div className="hub-panel-head">
          <h2>{t("inboxStack")}</h2>
          <span>{pendingFiles.length} {t("items")}</span>
        </div>
        <VirtualFileCardList files={pendingFiles} t={t} />
        <motion.button
          whileTap={{ scale: 0.985 }}
          className="hub-dispatch-button"
          onClick={runDispatch}
          disabled={isDispatching || !files.length}
          title={`${activeRuleCount} active rules`}
        >
          {isDispatching ? t("dispatching") : t("runDispatch")}
        </motion.button>
      </section>

      <motion.section className="hub-target-grid" variants={listMotion} initial="hidden" animate="show">
        {buckets.map((bucket) => {
          const bucketFiles = sortedFiles.filter((file) => fileBucket(file) === bucket.key);
          return (
            <motion.div
              className={`glass-panel target-bucket ${bucket.tone} ${bucketFiles.length ? "has-files" : ""}`}
              key={bucket.key}
              variants={itemMotion}
              layout
            >
              <div className="bucket-head">
                <div>
                  <h3>{bucket.label}</h3>
                  <small>{bucket.description}</small>
                </div>
                <span>{bucketFiles.length}</span>
              </div>
              <VirtualBucketFileList files={bucketFiles} setView={setView} waitingLabel={t("waitingFlow")} />
            </motion.div>
          );
        })}
      </motion.section>
    </div>
  );
}

function VirtualFileCardList({ files, t }: { files: FileRecord[]; t: Translator }) {
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
      <div className="hub-inbox-list">
        <div className="hub-empty">
          <Check size={24} />
          <span>{t("dispatchClear")}</span>
        </div>
      </div>
    );
  }

  if (!shouldVirtualize) {
    return (
      <motion.div className="hub-inbox-list" variants={listMotion} initial="hidden" animate="show">
        {files.map((file, index) => (
          <FileCard key={file.id} file={file} index={index} t={t} compact />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className="hub-inbox-list virtual-list">
      <div className="virtual-list-spacer" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index];
          return (
            <div
              className="virtual-row"
              key={file.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <FileCard file={file} index={virtualRow.index} t={t} compact />
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
      <div className="bucket-dropzone">
        <span>{waitingLabel}</span>
      </div>
    );
  }

  if (!shouldVirtualize) {
    return (
      <motion.div className="bucket-dropzone" variants={listMotion} initial="hidden" animate="show">
        {files.map((file) => (
          <BucketFileButton file={file} key={file.id} setView={setView} />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className="bucket-dropzone virtual-list">
      <div className="virtual-list-spacer" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index];
          return (
            <div
              className="virtual-row"
              key={file.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <BucketFileButton file={file} setView={setView} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BucketFileButton({ file, setView }: { file: FileRecord; setView: (view: View) => void }) {
  return (
    <motion.button className="bucket-file item-pop" layout variants={itemMotion} onClick={() => setView("preview")}>
      <File size={15} />
      <span>{file.name}</span>
    </motion.button>
  );
}

function isRuleClassified(file: FileRecord): boolean {
  return (
    file.matched_rules.length > 0 ||
    file.classification_reason !== "Indexed by Zen Canvas Tauri backend." ||
    file.purpose !== "Unknown"
  );
}

export function VaultView({
  page,
  setPage,
  selectedFile,
  searchQuery,
  setSearchQuery,
  setSelectedFileId,
  onRefreshStats,
  t
}: {
  page: FileQueryResult;
  setPage: (page: FileQueryResult | ((current: FileQueryResult) => FileQueryResult)) => void;
  selectedFile?: FileRecord;
  searchQuery: string;
  setSearchQuery: (searchQuery: string) => void;
  setSelectedFileId: (id: string) => void;
  onRefreshStats: () => Promise<void>;
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
    <div className="vault-layout page-enter">
      <div className="vault-chip-row">
        {filters.map((filter) => (
          <button
            key={filter.label}
            className={searchQuery === filter.key ? "active" : ""}
            onClick={() => setSearchQuery(filter.key)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="vault-filter-guide">
        {filters.map((filter) => (
          <span className={searchQuery === filter.key ? "active" : ""} key={`${filter.key}-description`}>
            <strong>{filter.label}</strong>
            {filter.description}
          </span>
        ))}
      </div>
      <p className="vault-helper">{t("libraryIntro")}</p>
      <label className="library-search-inline">
        <Search size={16} />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t("librarySearchPlaceholder")}
        />
      </label>
      <div className="vault-count-line">
        <span>{t("libraryShowing").replace("{visible}", String(page.files.length)).replace("{total}", String(page.total))}</span>
        {isLoading && <em>{t("loading")}</em>}
      </div>
      {error && <div className="system-toast inline">{error}</div>}
      <VirtualAssetGrid
        files={page.files}
        selectedFileId={selectedFile?.id}
        setSelectedFileId={setSelectedFileId}
      />
      <div ref={sentinelRef} className="vault-load-sentinel" />
      {hasMore && (
        <button className="glass-button vault-load-more" onClick={() => void loadPage(page.files.length, true)} disabled={isLoading}>
          <Plus size={16} />
          {t("loadMoreFiles").replace("{count}", String(Math.min(page.limit, page.total - page.files.length)))}
        </button>
      )}
    </div>
  );
}

function VirtualAssetGrid({
  files,
  selectedFileId,
  setSelectedFileId
}: {
  files: FileRecord[];
  selectedFileId?: string;
  setSelectedFileId: (id: string) => void;
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
      <motion.section className="vault-grid" variants={listMotion} initial="hidden" animate="show">
        {files.map((file) => (
          <AssetCard
            file={file}
            isSelected={selectedFileId === file.id}
            key={file.id}
            setSelectedFileId={setSelectedFileId}
          />
        ))}
      </motion.section>
    );
  }

  return (
    <section ref={parentRef} className="vault-grid-virtual virtual-list">
      <div className="virtual-list-spacer" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const start = virtualRow.index * columns;
          const rowFiles = files.slice(start, start + columns);
          return (
            <div
              className="vault-virtual-row"
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
                  setSelectedFileId={setSelectedFileId}
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
  setSelectedFileId
}: {
  file: FileRecord;
  isSelected: boolean;
  setSelectedFileId: (id: string) => void;
}) {
  return (
    <motion.button
      className={`asset-card glass-panel ${isSelected ? "selected" : ""}`}
      layout
      variants={itemMotion}
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
      <small>{file.directory || file.path}</small>
    </motion.button>
  );
});

export function TimelineView({
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
      <motion.div className="preview-folder-files compact" variants={listMotion} initial="hidden" animate="show">
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
    <div ref={parentRef} className="preview-folder-files compact virtualized virtual-list">
      <div className="virtual-list-spacer" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const preview = previews[virtualRow.index];
          return (
            <div
              className="virtual-row preview-virtual-row"
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
    <motion.div className="preview-file-row" layout variants={itemMotion}>
      <input
        type="checkbox"
        disabled={preview.is_executable === false}
        checked={isSelected}
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
    </motion.div>
  );
});

export function RulesView({ rules, onSave, t }: { rules: Rule[]; onSave: (rule: Rule) => Promise<void>; t: Translator }) {
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
      groups: [{
        id: localId("group"),
        operator: "AND",
        conditions: [{
          id: localId("cond"),
          field: field as Rule["groups"][number]["conditions"][number]["field"],
          operator: operator as Rule["groups"][number]["conditions"][number]["operator"],
          value
        }]
      }],
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
          <label>{t("ruleName")}<input value={name} onChange={(event) => setName(event.target.value)} /></label>
          <label>{t("field")}<select value={field} onChange={(event) => setField(event.target.value)}>{["name", "extension", "file_type", "path", "directory", "size", "modified_at", "risk_level"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>{t("operator")}<select value={operator} onChange={(event) => setOperator(event.target.value)}>{["contains", "equals", "startsWith", "endsWith", "greaterThan", "lessThan", "olderThanDays", "newerThanDays"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>{t("purpose")}<select value={purpose} onChange={(event) => setPurpose(event.target.value)}>{["Temporary", "Career", "Finance", "Study", "Project", "Personal", "Media", "Unknown"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>{t("lifecycle")}<select value={lifecycle} onChange={(event) => setLifecycle(event.target.value)}>{["Inbox", "Active", "Reference", "Archive", "Disposable", "Sensitive"].map((item) => <option key={item}>{item}</option>)}</select></label>
          <label>{t("weight")}<input type="number" value={weight} onChange={(event) => setWeight(Number(event.target.value))} /></label>
        </div>
        <button className="primary-command compact-command" onClick={submit}>
          <Plus size={17} />
          {t("saveRule")}
        </button>
      </section>

      <section className="glass-panel rules-list-panel">
        <SectionTitle title={t("strategy")} body={t("ruleLayerDesc")} />
        <VirtualRuleList rules={rules} />
      </section>
    </div>
  );
}

function VirtualRuleList({ rules }: { rules: Rule[] }) {
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
      <motion.div className="rule-list" variants={listMotion} initial="hidden" animate="show">
        {rules.map((rule) => (
          <RuleRow key={rule.id} rule={rule} />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className="rule-list virtual-list rules-virtual-list">
      <div className="virtual-list-spacer" style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const rule = rules[virtualRow.index];
          return (
            <div
              className="virtual-row"
              key={rule.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <RuleRow rule={rule} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const RuleRow = memo(function RuleRow({ rule }: { rule: Rule }) {
  return (
    <motion.div className="rule-row" layout variants={itemMotion}>
      <div>
        <strong>{rule.name}</strong>
        <span>{rule.source} / weight {rule.weight} / priority {rule.priority}</span>
      </div>
      <span className={`source ${rule.source}`}>{rule.source}</span>
      <span className={`toggle-switch ${rule.enabled ? "on" : ""}`} aria-hidden="true"><i /></span>
    </motion.div>
  );
});

export function RestoreView({ t }: { t: Translator }) {
  return (
    <div className="restore-layout page-enter">
      <section className="glass-panel restore-batches">
        <SectionTitle title={t("restoreRecords")} body={t("restoreDesc")} />
        <div className="empty-state">{t("noRestoreRecords")}</div>
        <div className="restore-log-divider" />
        <SectionTitle title={t("operationHistory")} body={t("timeMachineDesc")} />
        <div className="empty-state compact">{t("noOperationHistory")}</div>
      </section>

      <section className="glass-panel restore-preview">
        <div className="section-title action-title">
          <div>
            <h2>{t("restorePreview")}</h2>
            <p>{t("restorePreviewDesc")}</p>
          </div>
          <button className="glass-button primary" disabled>
            <RotateCcw size={16} />
            {t("restoreBatch")}
          </button>
        </div>
        <div className="empty-state compact">{t("noRestorePreview")}</div>
      </section>
    </div>
  );
}

export function SettingsView({
  language,
  setLanguage,
  theme,
  setTheme,
  platform,
  closeBehavior,
  setCloseBehavior,
  t
}: {
  language: Language;
  setLanguage: (language: Language) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  platform: NodeJS.Platform | "browser";
  closeBehavior: CloseBehavior;
  setCloseBehavior: (behavior: CloseBehavior) => Promise<void>;
  t: Translator;
}) {
  const [hotkey, setHotkey] = useState(defaultPlatformAccelerator(platform));
  const [backgroundResident, setBackgroundResident] = useState(false);
  const [launchAtLogin, setLaunchAtLogin] = useState(false);
  const [folderNamingLanguage, setFolderNamingLanguageState] = useState<FolderNamingLanguage>("en");
  const [defaultScanFolders, setDefaultScanFoldersState] = useState<DefaultScanFolder[]>(["Desktop", "Downloads", "Documents"]);
  const [restoreRetentionDays, setRestoreRetentionDaysState] = useState<RestoreRetentionDays>(30);
  const [settingsStatus, setSettingsStatus] = useState("");

  async function updateCloseBehavior(next: CloseBehavior) {
    await setCloseBehavior(next);
    setSettingsStatus(t("settingSaved"));
  }

  function toggleDefaultScanFolder(folder: DefaultScanFolder) {
    const next = defaultScanFolders.includes(folder)
      ? defaultScanFolders.filter((item) => item !== folder)
      : [...defaultScanFolders, folder];
    setDefaultScanFoldersState(next.length ? next : [folder]);
    setSettingsStatus(t("settingSaved"));
  }

  return (
    <div className="settings-layout page-enter">
      <section className="glass-panel settings-panel">
        <SectionTitle title={t("settings")} body={t("settingsDesc")} />
        <div className="setting-row">
          <div><strong>{t("language")}</strong><span>{t("languageDesc")}</span></div>
          <div className="segmented compact">
            <button className={language === "zh" ? "active" : ""} onClick={() => setLanguage("zh")}>中文</button>
            <button className={language === "en" ? "active" : ""} onClick={() => setLanguage("en")}>English</button>
          </div>
        </div>
        <div className="setting-row">
          <div><strong>{t("appearance")}</strong><span>{t("appearanceDesc")}</span></div>
          <div className="segmented compact tri">
            <button className={theme === "light" ? "active" : ""} onClick={() => setTheme("light")}>{t("lightTheme")}</button>
            <button className={theme === "dark" ? "active" : ""} onClick={() => setTheme("dark")}>{t("darkTheme")}</button>
            <button className={theme === "system" ? "active" : ""} onClick={() => setTheme("system")}>{t("systemTheme")}</button>
          </div>
        </div>
        <div className="setting-row">
          <div><strong>{t("folderNaming")}</strong><span>{t("folderNamingDesc")}</span></div>
          <div className="segmented compact">
            <button className={folderNamingLanguage === "en" ? "active" : ""} onClick={() => setFolderNamingLanguageState("en")}>Career</button>
            <button className={folderNamingLanguage === "zh" ? "active" : ""} onClick={() => setFolderNamingLanguageState("zh")}>{t("chineseFolderNames")}</button>
          </div>
        </div>
        <div className="setting-row vertical">
          <div><strong>{t("defaultScanFolders")}</strong><span>{t("defaultScanFoldersDesc")}</span></div>
          <div className="pill-check-grid">
            {(["Desktop", "Downloads", "Documents"] as DefaultScanFolder[]).map((folder) => (
              <button className={defaultScanFolders.includes(folder) ? "active" : ""} key={folder} onClick={() => toggleDefaultScanFolder(folder)}>
                {folder}
              </button>
            ))}
          </div>
        </div>
        <div className="setting-row">
          <div><strong>{t("searchHotkey")}</strong><span>{t("searchHotkeyDesc")}: {platform === "darwin" ? "⌘ K" : "Ctrl K"}</span></div>
          <div className="hotkey-editor">
            <input value={hotkey} onChange={(event) => setHotkey(event.target.value)} />
            <button className="glass-button" onClick={() => setSettingsStatus(t("hotkeySaved"))}>{t("save")}</button>
          </div>
        </div>
        <div className="setting-row">
          <div><strong>{t("backgroundResident")}</strong><span>{t("backgroundResidentDesc")}</span></div>
          <button className={`toggle-switch ${backgroundResident ? "on" : ""}`} onClick={() => setBackgroundResident((value) => !value)}><i /></button>
        </div>
        <div className="setting-row">
          <div><strong>{t("launchAtLogin")}</strong><span>{t("launchAtLoginDesc")}</span></div>
          <button className={`toggle-switch ${launchAtLogin ? "on" : ""}`} onClick={() => setLaunchAtLogin((value) => !value)}><i /></button>
        </div>
        <div className="setting-row">
          <div><strong>{t("closeBehavior")}</strong><span>{t("closeBehaviorDesc")}</span></div>
          <div className="segmented compact tri">
            <button className={closeBehavior === "ask" ? "active" : ""} onClick={() => void updateCloseBehavior("ask")}>{t("askEveryTime")}</button>
            <button className={closeBehavior === "minimize" ? "active" : ""} onClick={() => void updateCloseBehavior("minimize")}>{t("minimizeToTray")}</button>
            <button className={closeBehavior === "quit" ? "active" : ""} onClick={() => void updateCloseBehavior("quit")}>{t("quitApp")}</button>
          </div>
        </div>
        <div className="setting-row">
          <div><strong>{t("logRetention")}</strong><span>{t("logRetentionDesc")}</span></div>
          <div className="segmented compact">
            {([15, 30, 60, 90] as RestoreRetentionDays[]).map((days) => (
              <button className={restoreRetentionDays === days ? "active" : ""} key={days} onClick={() => setRestoreRetentionDaysState(days)}>
                {days} {t("days")}
              </button>
            ))}
          </div>
        </div>
        {settingsStatus && <div className="system-toast inline">{settingsStatus}</div>}
      </section>

      <section className="glass-panel settings-panel">
        <SectionTitle title={t("releaseReady")} body={t("releaseReadyDesc")} />
        <div className="setting-row">
          <div><strong>{t("searchSources")}</strong><span>{t("searchSourcesDesc")}</span></div>
          <span className="source user_space">{t("localOnly")}</span>
        </div>
        <div className="setting-row">
          <div><strong>{t("excludedDirs")}</strong><span>node_modules, .git, target, dist, build</span></div>
        </div>
      </section>
    </div>
  );
}

function FileCard({ file, index, t, compact = false }: { file: FileRecord; index: number; t: Translator; compact?: boolean }) {
  return (
    <motion.button
      className={`stack-card file-card ${compact ? "compact" : ""}`}
      layout
      variants={itemMotion}
      style={{ "--delay": `${Math.min(index * 18, 320)}ms` } as CSSProperties}
    >
      <File size={18} />
      <span>
        <strong>{file.name}</strong>
        <small>{file.purpose} / {formatBytes(file.size)}</small>
      </span>
      <em>{file.risk_level === "Sensitive" ? t("sensitiveLabel") : t("normal")}</em>
    </motion.button>
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
