import { type CSSProperties, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronRight, File, Folder, FolderSearch, Play, Plus, RefreshCw, RotateCcw, ShieldCheck, X } from "lucide-react";
import type { Language } from "../i18n";
import type { AppSnapshot, CloseBehavior, DefaultScanFolder, FileQuery, FileQueryResult, FileRecord, FolderNamingLanguage, OperationLog, OperationPreview, RestoreBatch, RestorePreview, RestoreRetentionDays, Rule, ScanProgress, SearchSource } from "../types/domain";
import type { ThemeMode, Translator, View } from "../types/ui";
import { formatBytes, formatDate, percent } from "../utils/format";
import { demoSnapshot } from "../mocks/demoData";
import { acceleratorForElectron, compactPath, defaultPlatformAccelerator, groupOperationPreviews, localId, nowIso, platformAcceleratorForInput, samePathLike, splitDisplaySize, sumUniqueDiskTotal } from "../utils/viewHelpers";

export function ScannerView({
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

export function HubView({
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

export function VaultView({
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
                          items={subgroup.items}
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
  items,
  selectedIds,
  toggle,
  onRenamePreview,
  t
}: {
  items: OperationPreview[];
  selectedIds: Set<string>;
  toggle: (id: string) => void;
  onRenamePreview: (id: string, name: string) => void;
  t: Translator;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const rowVirtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 122,
    overscan: 6
  });
  const height = Math.min(430, Math.max(122, items.length * 122));

  return (
    <div className="preview-folder-files compact virtualized" ref={parentRef} style={{ height }}>
      <div
        className="preview-virtual-spacer"
        style={{ height: rowVirtualizer.getTotalSize(), position: "relative", width: "100%" }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualItem) => {
          const preview = items[virtualItem.index];
          return (
            <div
              className="preview-virtual-row"
              key={preview.id}
              data-index={virtualItem.index}
              ref={rowVirtualizer.measureElement}
              style={{
                position: "absolute",
                left: 0,
                top: 0,
                width: "100%",
                transform: `translateY(${virtualItem.start}px)`
              }}
            >
              <div className="preview-file-row">
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
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function RulesView({
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

export function RestoreView({ hasNativeApi, t }: { hasNativeApi: boolean; t: Translator }) {
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

export function SettingsView({
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
