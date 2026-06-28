import { useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { Folder, Play, X } from "lucide-react";
import type { OperationProgressPayload } from "../../api/tauriApi";
import { useChromeContext } from "../../contexts/AppContexts";
import { useFileLibraryStore } from "../../store/useFileLibraryStore";
import { useOperationQueueStore } from "../../store/useOperationQueueStore";
import type { OperationPreview } from "../../types/domain";
import type { Translator } from "../../types/ui";
import { groupOperationPreviews, compactPath, libraryScopeLabel } from "../../utils/viewHelpers";
import { shouldVirtualizeList } from "../../utils/virtualization";
import { cn, emptyState, glassButton, glassButtonPrimary, sectionTitle, virtualList, virtualRow as virtualRowClass, virtualSpacer } from "../../utils/tw";
import { listMotion, pageSurface, panelSurface, rowSurface } from "../shared/ui";
import { PreviewFileRow } from "./PreviewFileRow";

const PREVIEW_ROW_HEIGHT = 156;

export function TimelineView() {
  const { t, setView } = useChromeContext();
  const scope = useFileLibraryStore((state) => state.scope);
  const previews = useOperationQueueStore((state) => state.displayPreviews);
  const previewScope = useOperationQueueStore((state) => state.previewScope);
  const previewTotal = useOperationQueueStore((state) => state.previewTotal);
  const previewLimit = useOperationQueueStore((state) => state.previewLimit);
  const previewTruncated = useOperationQueueStore((state) => state.previewTruncated);
  const previewHasMore = useOperationQueueStore((state) => state.previewHasMore);
  const selectedIds = useOperationQueueStore((state) => state.selectedOperationIds);
  const setSelectedIds = useOperationQueueStore((state) => state.setSelectedOperationIds);
  const loadMorePreviews = useOperationQueueStore((state) => state.loadMorePreviews);
  const onRenamePreview = useOperationQueueStore((state) => state.onRenamePreview);
  const executeSelected = useOperationQueueStore((state) => state.executeSelected);
  const operationProgress = useOperationQueueStore((state) => state.operationProgress);
  const isOperationCanceling = useOperationQueueStore((state) => state.isOperationCanceling);
  const cancelOperations = useOperationQueueStore((state) => state.cancelOperations);
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
  const confirmationCount = previews.filter((preview) => preview.requires_confirmation).length;
  const autoCreateParentCount = previews.filter((preview) => preview.will_create_parent).length;
  const executeProgress = operationProgress?.kind === "execute" ? operationProgress : null;
  const isExecuting = Boolean(executeProgress);
  const scopeText = libraryScopeLabel(previewScope ?? scope, t("allIndexedFiles"), t("noFolderSelected"));
  const coveredTotal = previewTotal || previews.length;

  return (
    <div className={pageSurface}>
      <section className={panelSurface}>
        <div className={cn(sectionTitle, "items-center")}>
          <div>
            <h2>{t("suggestedPlan")}</h2>
            <p>{t("previewBeforeExecute")}</p>
            <p className="truncate text-xs text-[var(--muted)]">{t("currentOrganizeScope")}: {scopeText}</p>
          </div>
          <button className={glassButtonPrimary} onClick={executeSelected} disabled={!selectedIds.size || isExecuting}>
            <Play size={16} />
            <span>{isExecuting ? t("executingOperations") : t("executeSelected")} / {selectedIds.size}</span>
          </button>
        </div>
        <div className="mb-4 grid gap-2 text-sm text-[var(--muted)] sm:grid-cols-5">
          <span>{t("previewScopeItems")}: <strong>{coveredTotal.toLocaleString()}</strong></span>
          <span>{t("previewMainFolders")}: <strong>{groups.length}</strong></span>
          <span>{t("executableItems")}: <strong>{executableCount}</strong></span>
          <span>{t("blockedItems")}: <strong>{blockedCount}</strong></span>
          <span>{t("confirmationItems")}: <strong>{confirmationCount}</strong></span>
        </div>
        {previewTruncated && (
          <div className="mb-4 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-200">
            {t("previewTruncatedWarning")
              .replace("{limit}", previewLimit.toLocaleString())
              .replace("{total}", coveredTotal.toLocaleString())}
          </div>
        )}
        {autoCreateParentCount > 0 && (
          <div className="mb-4 rounded-lg border border-blue-400/40 bg-blue-500/10 px-3 py-2 text-sm text-blue-700 dark:text-blue-200">
            {t("autoCreateFolderHint").replace("{count}", autoCreateParentCount.toLocaleString())}
          </div>
        )}
        {executeProgress && (
          <OperationProgressPanel
            progress={executeProgress}
            isCanceling={isOperationCanceling}
            onCancel={cancelOperations}
            t={t}
          />
        )}
        {!previews.length ? (
          <div className={cn(emptyState, "grid min-h-48 place-items-center gap-4 px-6 text-center")}>
            <div>
              <strong className="block text-base text-[var(--ink)]">{t("previewEmptyTitle")}</strong>
              <span className="mt-2 block max-w-xl text-sm text-[var(--muted)]">{t("previewEmptyDesc")}</span>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <button className={glassButtonPrimary} onClick={() => setView("organize")}>
                {t("goSmartDispatch")}
              </button>
              <button className={glassButton} onClick={() => setView("rules")}>
                {t("goRuleEngine")}
              </button>
            </div>
          </div>
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
            {previewHasMore && (
              <button className={glassButton} onClick={loadMorePreviews}>
                {t("loadMoreFiles").replace("{count}", Math.max(0, coveredTotal - previews.length).toLocaleString())}
              </button>
            )}
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

export function OperationProgressPanel({
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
