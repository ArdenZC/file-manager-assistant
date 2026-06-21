import { useCallback, useEffect, useMemo, useState } from "react";
import { tauriApi } from "./api/tauriApi";
import { AppShell } from "./components/AppShell";
import {
  ChromeProvider,
  FileLibraryProvider,
  OperationQueueProvider,
  RulesProvider,
  ScanProvider,
  SettingsProvider
} from "./contexts/AppContexts";
import { makeTranslator } from "./i18n";
import { useAppChrome } from "./hooks/useAppChrome";
import { useDebounce } from "./hooks/useDebounce";
import { useFileLibrary } from "./hooks/useFileLibrary";
import { useFsWatcher } from "./hooks/useFsWatcher";
import { useAppSettings } from "./hooks/useAppSettings";
import { useOperationQueue } from "./hooks/useOperationQueue";
import { useRulePersistence } from "./hooks/useRulePersistence";
import { useScanManager } from "./hooks/useScanManager";
import { useWindowBehavior } from "./hooks/useWindowBehavior";
import { useAppStore } from "./store/useAppStore";
import { useRulesStore } from "./store/useRulesStore";
import { persistRuleEnabledToggle, persistUserRuleDelete } from "./store/rulePersistence";
import type {
  CloseBehavior,
  DefaultScanFolder,
  FolderNamingLanguage,
  RestoreRetentionDays,
  Rule
} from "./types/domain";
import { readableError } from "./utils/viewHelpers";
import { applySearchNavigation } from "./utils/searchNavigation";

export function App() {
  const language = useAppStore((state) => state.language);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const rules = useRulesStore((state) => state.rules);
  const upsertRule = useRulesStore((state) => state.upsertRule);
  const removeUserRule = useRulesStore((state) => state.removeUserRule);
  const hydrateUserRulesFromSQLite = useRulesStore((state) => state.hydrateUserRulesFromSQLite);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);
  const [databaseError, setDatabaseError] = useState("");
  const [isDatabaseReady, setIsDatabaseReady] = useState(false);

  const t = useMemo(() => makeTranslator(language), [language]);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const showSuccess = useCallback((message: string) => setToast({ message, type: "success" }), []);
  const showError = useCallback((message: string) => setToast({ message, type: "error" }), []);
  const formatSettingsLoadError = useCallback(
    (error: unknown) => `${t("settingsLoadFailed")}：${readableError(error)}`,
    [t]
  );
  const formatSettingsSaveError = useCallback(
    (error: unknown) => `${t("settingsSaveFailed")}：${readableError(error)}`,
    [t]
  );
  const fileLibrary = useFileLibrary({
    debouncedSearchQuery,
    onError: showError
  });
  const { files, setSelectedFileId, refresh } = fileLibrary;

  useEffect(() => {
    let cancelled = false;

    async function initializeDatabase() {
      try {
        await tauriApi.initDatabase();
        if (cancelled) return;
        setDatabaseError("");
        setIsDatabaseReady(true);
      } catch (error) {
        if (cancelled) return;
        const message = `无法访问数据库：${readableError(error)}`;
        setIsDatabaseReady(false);
        setDatabaseError(message);
        showError(message);
      }
    }

    void initializeDatabase();

    return () => {
      cancelled = true;
    };
  }, [showError]);

  useEffect(() => {
    if (isDatabaseReady) void refresh();
  }, [isDatabaseReady, refresh]);
  useRulePersistence({
    isDatabaseReady,
    rules,
    hydrateUserRulesFromSQLite,
    onError: showError
  });
  const appSettingsState = useAppSettings({
    isDatabaseReady,
    onError: showError,
    formatLoadError: formatSettingsLoadError,
    formatSaveError: formatSettingsSaveError
  });
  const { settings: appSettings, isLoadingSettings, updateSettings } = appSettingsState;
  useFsWatcher({ onRefreshData: refresh, onError: showError, rules });

  const appChrome = useAppChrome({ theme, setTheme, setLanguage });
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void tauriApi.onSearchNavigate((payload) => {
      applySearchNavigation(payload, setView, setSelectedFileId);
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => {
      if (!disposed) showError(readableError(error));
    });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [setSelectedFileId, setView, showError]);

  const setCloseBehavior = useCallback(
    async (next: CloseBehavior) => {
      const savedSettings = await updateSettings({ closeBehavior: next });
      return savedSettings.closeBehavior === next;
    },
    [updateSettings]
  );
  const setFolderNamingLanguage = useCallback(
    async (next: FolderNamingLanguage) => {
      const savedSettings = await updateSettings({ folderNamingLanguage: next });
      return savedSettings.folderNamingLanguage === next;
    },
    [updateSettings]
  );
  const setDefaultScanFolders = useCallback(
    async (next: DefaultScanFolder[]) => {
      const savedSettings = await updateSettings({ defaultScanFolders: next });
      return arraysEqual(savedSettings.defaultScanFolders, next);
    },
    [updateSettings]
  );
  const setRestoreRetentionDays = useCallback(
    async (next: RestoreRetentionDays) => {
      const savedSettings = await updateSettings({ restoreRetentionDays: next });
      return savedSettings.restoreRetentionDays === next;
    },
    [updateSettings]
  );
  const setLaunchAtLogin = useCallback(
    async (next: boolean) => {
      const savedSettings = await updateSettings({ launchAtLogin: next });
      return savedSettings.launchAtLogin === next;
    },
    [updateSettings]
  );
  const windowBehavior = useWindowBehavior({
    closeBehavior: appSettings.closeBehavior,
    setCloseBehavior
  });
  const scanManager = useScanManager({
    t,
    onRefreshData: refresh,
    onError: showError,
    onSuccess: showSuccess
  });
  const operationQueue = useOperationQueue({
    files,
    rules,
    t,
    onRefreshData: refresh,
    onError: showError,
    onSuccess: showSuccess
  });

  const saveRule = useCallback(async (rule: Rule) => {
    try {
      const savedRule = await tauriApi.saveUserRule(rule);
      upsertRule(savedRule);
    } catch (error) {
      upsertRule(rule);
      showError(`规则已保存到本地缓存，但同步 SQLite 失败：${readableError(error)}`);
    }
  }, [showError, upsertRule]);
  const toggleRuleEnabled = useCallback(async (rule: Rule, enabled: boolean) => {
    await persistRuleEnabledToggle({
      rule,
      enabled,
      saveUserRule: tauriApi.saveUserRule,
      upsertRule,
      onSyncError: (error) => {
        showError(`规则已更新到本地缓存，但同步 SQLite 失败：${readableError(error)}`);
      }
    });
  }, [showError, upsertRule]);
  const deleteRule = useCallback(async (rule: Rule) => {
    if (rule.source !== "user") {
      showError(t("systemRuleCannotDelete"));
      return;
    }

    const deleted = await persistUserRuleDelete({
      rule,
      deleteUserRule: tauriApi.deleteUserRule,
      removeRule: removeUserRule,
      onNotDeleted: () => {
        showError("规则不存在或不是用户规则");
      },
      onSyncError: (error) => {
        showError(`${t("ruleDeleteFailed")}：${readableError(error)}`);
      }
    });
    if (deleted) {
      showSuccess(t("ruleDeleted"));
    }
  }, [removeUserRule, showError, showSuccess, t]);
  const settingsContextValue = useMemo(() => ({
    settings: appSettings,
    isLoadingSettings,
    updateSettings,
    setFolderNamingLanguage,
    setDefaultScanFolders,
    setRestoreRetentionDays,
    setLaunchAtLogin
  }), [
    appSettings,
    isLoadingSettings,
    updateSettings,
    setFolderNamingLanguage,
    setDefaultScanFolders,
    setRestoreRetentionDays,
    setLaunchAtLogin
  ]);
  const rulesContextValue = useMemo(() => ({
    rules,
    saveRule,
    toggleRuleEnabled,
    deleteRule
  }), [deleteRule, rules, saveRule, toggleRuleEnabled]);
  const chromeContextValue = useMemo(() => ({
    ...appChrome,
    ...windowBehavior,
    language,
    setLanguage,
    theme,
    setTheme,
    view,
    setView,
    searchQuery,
    setSearchQuery,
    toast,
    onError: showError,
    t
  }), [
    appChrome,
    windowBehavior,
    language,
    setLanguage,
    theme,
    setTheme,
    view,
    setView,
    searchQuery,
    setSearchQuery,
    toast,
    showError,
    t
  ]);

  if (databaseError) {
    return <DatabaseUnavailableState message={databaseError} toast={toast} />;
  }

  return (
    <ChromeProvider value={chromeContextValue}>
      <FileLibraryProvider value={fileLibrary}>
        <ScanProvider value={scanManager}>
          <OperationQueueProvider value={operationQueue}>
            <SettingsProvider value={settingsContextValue}>
              <RulesProvider value={rulesContextValue}>
                <AppShell />
              </RulesProvider>
            </SettingsProvider>
          </OperationQueueProvider>
        </ScanProvider>
      </FileLibraryProvider>
    </ChromeProvider>
  );
}

function arraysEqual(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function DatabaseUnavailableState({
  message,
  toast
}: {
  message: string;
  toast: { message: string; type: "success" | "error" | "info" } | null;
}) {
  return (
    <main className="grid h-screen min-h-[520px] place-items-center bg-[var(--bg)] px-6 text-[var(--ink)]">
      <section className="w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 text-center shadow-[var(--shadow)] backdrop-blur-3xl">
        {toast && (
          <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-left text-sm text-red-600 dark:text-red-300">
            {toast.message}
          </div>
        )}
        <h1 className="text-xl font-semibold">无法访问数据库</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">{message}</p>
      </section>
    </main>
  );
}
