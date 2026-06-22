import { create } from "zustand";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { tauriApi, type OperationProgressPayload, type RuleExecutionSummary } from "../api/tauriApi";
import { makeTranslator } from "../i18n";
import type { FileRecord, OperationLog, OperationPreview } from "../types/domain";
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
  previewActionCount: number;
  operationProgress: OperationProgressPayload | null;
  isOperationCanceling: boolean;
  activeOperationKind: OperationProgressPayload["kind"] | null;
  listenersRegistered: boolean;
  unlistener?: UnlistenFn;
  initializeOperationQueue: () => Promise<void>;
  loadPersistedOperationLogs: () => Promise<void>;
  syncPreviews: (files: FileRecord[]) => void;
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
      selectedOperationIds: new Set(
        previews.filter((preview) => preview.selected_by_default).map((preview) => preview.id)
      ),
      previewActionCount: previewActionCount(displayPreviews)
    });
  },
  setSelectedOperationIds: (selectedOperationIds) => set({ selectedOperationIds }),
  runDispatch: async () => {
    const t = currentT();
    try {
      const summary = await tauriApi.executeRulesForScope(
        useFileLibraryStore.getState().scope,
        useRulesStore.getState().rules
      );
      await useFileLibraryStore.getState().refresh(useAppStore.getState().searchQuery);
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
