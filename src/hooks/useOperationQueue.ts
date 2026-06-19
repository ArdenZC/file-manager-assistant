import { useCallback, useEffect, useMemo, useState } from "react";
import { tauriApi } from "../api/tauriApi";
import type { FileRecord, OperationLog, OperationPreview } from "../types/domain";
import type { Translator } from "../types/ui";
import { applyPreviewNameOverride, createOperationPreviews, readableError } from "../utils/viewHelpers";

const MAX_LOGS = 500;

interface UseOperationQueueOptions {
  files: FileRecord[];
  t: Translator;
  loadStats: () => Promise<void>;
  loadFirstPage: () => Promise<void>;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}

export function useOperationQueue({
  files,
  t,
  loadStats,
  loadFirstPage,
  showSuccess,
  showError
}: UseOperationQueueOptions) {
  const [operationLogs, setOperationLogs] = useState<OperationLog[]>([]);
  const [selectedOperationIds, setSelectedOperationIds] = useState<Set<string>>(new Set());
  const [previewNameOverrides, setPreviewNameOverrides] = useState<Record<string, string>>({});

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

  const onRenamePreview = useCallback((id: string, name: string) => {
    setPreviewNameOverrides((current) => ({ ...current, [id]: name }));
  }, []);

  const executeSelected = useCallback(async () => {
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
  }, [displayPreviews, loadFirstPage, loadStats, selectedOperationIds, showError, showSuccess, t]);

  const restoreOperationLogs = useCallback(
    async (logs: OperationLog[]) => {
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
    },
    [loadFirstPage, loadStats, showError, showSuccess, t]
  );

  return {
    operationLogs,
    selectedOperationIds,
    setSelectedOperationIds,
    displayPreviews,
    previewActionCount,
    executeSelected,
    restoreOperationLogs,
    onRenamePreview
  };
}
