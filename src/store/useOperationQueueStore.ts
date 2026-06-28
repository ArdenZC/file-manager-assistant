import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { tauriApi, type OperationProgressPayload, type RuleExecutionSummary } from "../api/tauriApi";
import { makeTranslator } from "../i18n";
import type { FileRecord, LibraryScope, OperationLog, OperationPreview, OperationPreviewResult } from "../types/domain";
import { applyPreviewNameOverride, createOperationPreviews, readableError } from "../utils/viewHelpers";
import { useAppStore } from "./useAppStore";
import { useFileLibraryStore } from "./useFileLibraryStore";
import { useRulesStore } from "./useRulesStore";

export const MAX_LOGS = 500;

export interface OperationQueueStore {
  operationLogs: OperationLog[];
  selectedOperationIds: Set<string>;
  previewNameOverrides: Record<string, string>;
  previews: OperationPreview[];
  displayPreviews: OperationPreview[];
  previewScope: LibraryScope | null;
  previewTotal: number;
  previewLimit: number;
  previewOffset: number;
  previewTruncated: boolean;
  previewHasMore: boolean;
  previewActionCount: number;
  operationProgress: OperationProgressPayload | null;
  isOperationCanceling: boolean;
  activeOperationKind: OperationProgressPayload["kind"] | null;
  listenersRegistered: boolean;
  unlistener?: UnlistenFn;
  initializeOperationQueue: () => Promise<void>;
  loadPersistedOperationLogs: () => Promise<void>;
  syncPreviews: (files: FileRecord[]) => void;
  setPreviewResult: (result: OperationPreviewResult, scope: LibraryScope) => void;
  loadMorePreviews: () => Promise<void>;
  setSelectedOperationIds: (ids: Set<string>) => void;
  runDispatch: () => Promise<RuleExecutionSummary>;
  executeSelected: () => Promise<void>;
  restoreOperationLogs: (logs: OperationLog[]) => Promise<void>;
  cancelOperations: () => Promise<void>;
  onRenamePreview: (id: string, name: string) => void;
}

function currentT() {
  return makeTranslator(useAppStore.getState().language);
}

function applyOverrides(
  previews: OperationPreview[],
  previewNameOverrides: Record<string, string>
) {
  return previews.map((preview) => applyPreviewNameOverride(preview, previewNameOverrides[preview.id]));
}

function previewActionCount(displayPreviews: OperationPreview[]) {
  return displayPreviews.filter((preview) => preview.status === "pending").length;
}

function defaultSelectedPreviewIds(previews: OperationPreview[]) {
  return new Set(
    previews
      .filter((preview) => preview.selected_by_default && preview.is_executable !== false)
      .map((preview) => preview.id)
  );
}

export function mergeOperationLogs(persisted: OperationLog[], current: OperationLog[]): OperationLog[] {
  const seen = new Set<string>();
  const merged: OperationLog[] = [];
  for (const log of [...current, ...persisted]) {
    if (seen.has(log.id)) continue;
    seen.add(log.id);
    merged.push(log);
  }
  return merged.slice(0, MAX_LOGS);
}

export const useOperationQueueStore = create<OperationQueueStore>((set, get) => ({
  operationLogs: [],
  selectedOperationIds: new Set(),
  previewNameOverrides: {},
  previews: [],
  displayPreviews: [],
  previewScope: null,
  previewTotal: 0,
  previewLimit: 0,
  previewOffset: 0,
  previewTruncated: false,
  previewHasMore: false,
  previewActionCount: 0,
  operationProgress: null,
  isOperationCanceling: false,
  activeOperationKind: null,
  listenersRegistered: false,
  initializeOperationQueue: async () => {
    if (get().listenersRegistered) return;
    set({ listenersRegistered: true });
    await get().loadPersistedOperationLogs();

    try {
      const unlistener = await tauriApi.onOperationProgress((payload) => {
        if (get().activeOperationKind !== payload.kind) return;
        set({ operationProgress: payload });
      });
      set({ unlistener });
    } catch (error) {
      useAppStore.getState().showError(readableError(error));
    }
  },
  loadPersistedOperationLogs: async () => {
    try {
      const persistedLogs = await tauriApi.getOperationLogs(MAX_LOGS);
      set((state) => ({
        operationLogs: mergeOperationLogs(persistedLogs, state.operationLogs)
      }));
    } catch (error) {
      useAppStore.getState().showError(readableError(error));
    }
  },
  syncPreviews: (files) => {
    const previews = createOperationPreviews(files);
    const displayPreviews = applyOverrides(previews, {});
    set({
      previews,
      displayPreviews,
      previewNameOverrides: {},
      selectedOperationIds: defaultSelectedPreviewIds(previews),
      previewScope: null,
      previewTotal: previews.length,
      previewLimit: previews.length,
      previewOffset: 0,
      previewTruncated: false,
      previewHasMore: false,
      previewActionCount: previewActionCount(displayPreviews)
    });
  },
  setPreviewResult: (result, scope) => {
    const displayPreviews = applyOverrides(result.previews, {});
    set({
      previews: result.previews,
      displayPreviews,
      previewNameOverrides: {},
      selectedOperationIds: defaultSelectedPreviewIds(result.previews),
      previewScope: scope,
      previewTotal: result.total,
      previewLimit: result.limit,
      previewOffset: result.offset,
      previewTruncated: result.truncated,
      previewHasMore: result.hasMore,
      previewActionCount: previewActionCount(displayPreviews)
    });
  },
  loadMorePreviews: async () => {
    const state = get();
    if (!state.previewScope || !state.previewHasMore) return;

    const limit = state.previewLimit || 1000;
    const offset = state.previewOffset + state.previews.length;
    try {
      const result = await tauriApi.getOperationPreviewsForScope(
        state.previewScope,
        undefined,
        limit,
        offset
      );
      set((current) => {
        const seen = new Set(current.previews.map((preview) => preview.id));
        const appended = result.previews.filter((preview) => !seen.has(preview.id));
        const previews = [...current.previews, ...appended];
        const selectedOperationIds = new Set(current.selectedOperationIds);
        for (const id of defaultSelectedPreviewIds(appended)) {
          selectedOperationIds.add(id);
        }
        const displayPreviews = applyOverrides(previews, current.previewNameOverrides);
        return {
          previews,
          displayPreviews,
          selectedOperationIds,
          previewTotal: result.total,
          previewLimit: result.limit,
          previewTruncated: result.truncated,
          previewHasMore: result.hasMore,
          previewActionCount: previewActionCount(displayPreviews)
        };
      });
    } catch (error) {
      useAppStore.getState().showError(readableError(error));
      throw error;
    }
  },
  setSelectedOperationIds: (selectedOperationIds) => set({ selectedOperationIds }),
  runDispatch: async () => {
    const t = currentT();
    try {
      const scope = useFileLibraryStore.getState().scope;
      const summary = await tauriApi.executeRulesForScope(
        scope,
        useRulesStore.getState().rules,
        "inbox_only"
      );
      await useFileLibraryStore.getState().refresh(useAppStore.getState().searchQuery);
      const previews = await tauriApi.getOperationPreviewsForScope(scope);
      get().setPreviewResult(previews, scope);
      useAppStore.getState().showSuccess(
        `${t("success")}: ${summary.updated.toLocaleString()} / ${summary.scanned.toLocaleString()} (${t("skipped")}: ${summary.skipped.toLocaleString()})`
      );
      return summary;
    } catch (error) {
      useAppStore.getState().showError(readableError(error));
      throw error;
    }
  },
  executeSelected: async () => {
    const t = currentT();
    const { displayPreviews, selectedOperationIds } = get();
    const operations = displayPreviews.filter(
      (preview) => selectedOperationIds.has(preview.id) && preview.is_executable !== false
    );
    if (!operations.length) return;

    set({
      activeOperationKind: "execute",
      isOperationCanceling: false,
      operationProgress: {
        kind: "execute",
        batchId: "",
        processed: 0,
        total: operations.length,
        currentPath: operations[0]?.source_path ?? ""
      }
    });

    try {
      const result = await tauriApi.executeMoves(operations as OperationPreview[]);
      set((state) => ({
        operationLogs: [...result.logs, ...state.operationLogs].slice(0, MAX_LOGS),
        selectedOperationIds: new Set()
      }));
      await useFileLibraryStore.getState().refresh(useAppStore.getState().searchQuery);
      const canceled = result.logs.some((log) => log.status === "skipped");
      useAppStore.getState().showSuccess(canceled ? t("operationCanceled") : t("success"));
    } catch (error) {
      useAppStore.getState().showError(readableError(error));
    } finally {
      set({
        activeOperationKind: null,
        isOperationCanceling: false,
        operationProgress: null
      });
    }
  },
  restoreOperationLogs: async (logs) => {
    const t = currentT();
    if (!logs.length) return;

    set({
      activeOperationKind: "restore",
      isOperationCanceling: false,
      operationProgress: {
        kind: "restore",
        batchId: logs[0]?.batch_id ?? "",
        processed: 0,
        total: logs.length,
        currentPath: logs[0]?.path_after ?? ""
      }
    });

    try {
      const result = await tauriApi.restoreMoves(logs);
      const updatedById = new Map(result.logs.map((log) => [log.id, log]));
      set((state) => ({
        operationLogs: state.operationLogs.map((log) => updatedById.get(log.id) ?? log)
      }));
      await useFileLibraryStore.getState().refresh(useAppStore.getState().searchQuery);
      const canceled = result.logs.some((log) => log.restore_status === "canceled");
      useAppStore.getState().showSuccess(canceled ? t("operationCanceled") : `${t("restored")}: ${result.restored.toLocaleString()}`);
    } catch (error) {
      useAppStore.getState().showError(readableError(error));
    } finally {
      set({
        activeOperationKind: null,
        isOperationCanceling: false,
        operationProgress: null
      });
    }
  },
  cancelOperations: async () => {
    if (!get().activeOperationKind) return;
    set({ isOperationCanceling: true });
    try {
      await tauriApi.cancelOperations();
    } catch (error) {
      set({ isOperationCanceling: false });
      useAppStore.getState().showError(readableError(error));
    }
  },
  onRenamePreview: (id, name) => {
    set((state) => {
      const previewNameOverrides = { ...state.previewNameOverrides, [id]: name };
      const displayPreviews = applyOverrides(state.previews, previewNameOverrides);
      return {
        previewNameOverrides,
        displayPreviews,
        previewActionCount: previewActionCount(displayPreviews)
      };
    });
  }
}));
