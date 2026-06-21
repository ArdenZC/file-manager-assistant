import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { Check, ChevronRight, File, Folder, FolderOpen, Play, Plus, RotateCcw, Search, Trash2, X } from "lucide-react";
import { tauriApi, type OperationProgressPayload } from "../api/tauriApi";
import { nextDefaultScanFolders } from "../hooks/useAppSettings";
import type { Language } from "../i18n";
import type {
  CloseBehavior,
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
  localId,
  nowIso
} from "../utils/viewHelpers";
import { shouldVirtualizeList } from "../utils/virtualization";
import { OperationProgressPanel } from "./timeline/TimelineView";
import { revealFileFromCard } from "./shared/cardActions";
import {
  compactRowSurface,
  formGrid,
  itemMotion,
  listMotion,
  mutedText,
  pageSurface,
  panelSurface,
  quietText,
  rowSurface,
  segmented,
  segmentButton,
  SectionTitle,
  sourceBadge,
  toggleSwitch
} from "./shared/ui";
import {
  cn,
  emptyState,
  glassButton,
  glassButtonPrimary,
  inputSurface,
  sectionTitle,
  selectSurface,
  statusToast,
  toneClasses,
  virtualList,
  virtualRow as virtualRowClass,
  virtualSpacer
} from "../utils/tw";

export { ScannerView } from "./scanner/ScannerView";

export { HubView } from "./hub/HubView";

export { VaultView } from "./vault/VaultView";

export { TimelineView } from "./timeline/TimelineView";

export { RulesView } from "./rules/RulesView";

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

