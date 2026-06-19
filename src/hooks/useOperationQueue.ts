import { useCallback, useEffect, useMemo, useState } from "react";
import { tauriApi } from "../api/tauriApi";
import type { FileRecord, OperationLog, OperationPreview, Rule } from "../types/domain";
import type { Translator } from "../types/ui";
import { applyPreviewNameOverride, createOperationPreviews, readableError } from "../utils/viewHelpers";

const MAX_LOGS = 500;

export interface OperationQueueOptions {
  files: FileRecord[];
  rules: Rule[];
  t: Translator;
  onRefreshData: () => Promise<void>;
  onError: (message: string) => void;
  onSuccess: (message: string) => void;
}

export function useOperationQueue({
  files,
  rules,
  t,
  onRefreshData,
  onError,
  onSuccess
}: OperationQueueOptions) {
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

  const runDispatch = useCallback(async () => {
    try {
      const summary = await tauriApi.executeRulesOnInbox(rules);
      await onRefreshData();
      onSuccess(`${t("success")}: ${summary.updated.toLocaleString()} / ${summary.scanned.toLocaleString()}`);
      return summary;
    } catch (error) {
      onError(readableError(error));
      throw error;
    }
  }, [onError, onRefreshData, onSuccess, rules, t]);

  const executeSelected = useCallback(async () => {
    const operations = displayPreviews.filter(
      (preview) => selectedOperationIds.has(preview.id) && preview.is_executable !== false
    );
    if (!operations.length) return;
    try {
      const result = await tauriApi.executeMoves(operations as OperationPreview[]);
      setOperationLogs((current) => [...result.logs, ...current].slice(0, MAX_LOGS));
      setSelectedOperationIds(new Set());
      await onRefreshData();
      onSuccess(t("success"));
    } catch (error) {
      onError(readableError(error));
    }
  }, [displayPreviews, onError, onRefreshData, onSuccess, selectedOperationIds, t]);

  const restoreOperationLogs = useCallback(async (logs: OperationLog[]) => {
    if (!logs.length) return;
    try {
      const result = await tauriApi.restoreMoves(logs);
      const updatedById = new Map(result.logs.map((log) => [log.id, log]));
      setOperationLogs((current) => current.map((log) => updatedById.get(log.id) ?? log));
      await onRefreshData();
      onSuccess(`${t("restored")}: ${result.restored.toLocaleString()}`);
    } catch (error) {
      onError(readableError(error));
    }
  }, [onError, onRefreshData, onSuccess, t]);

  function onRenamePreview(id: string, name: string) {
    setPreviewNameOverrides((current) => ({ ...current, [id]: name }));
  }

  return {
    operationLogs,
    selectedOperationIds,
    setSelectedOperationIds,
    displayPreviews,
    previewActionCount,
    runDispatch,
    executeSelected,
    restoreOperationLogs,
    onRenamePreview
  };
}
