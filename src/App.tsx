import { useCallback, useEffect, useMemo, useState } from "react";
import { tauriApi } from "./api/tauriApi";
import { AppShell } from "./components/AppShell";
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
import type { Rule } from "./types/domain";
import { readableError } from "./utils/viewHelpers";

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
  const { stats, libraryPage, setLibraryPage, files, selectedFile, setSelectedFileId, loadStats, refresh } =
    useFileLibrary({
      debouncedSearchQuery,
      onError: showError
    });

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
  const { settings: appSettings, updateSettings } = useAppSettings({
    isDatabaseReady,
    onError: showError,
    formatLoadError: formatSettingsLoadError,
    formatSaveError: formatSettingsSaveError
  });
  useFsWatcher({ onRefreshData: refresh, onError: showError, rules });

  const appChrome = useAppChrome({ theme, setTheme, setLanguage });
  const setCloseBehavior = useCallback(
    async (next: typeof appSettings.closeBehavior) => {
      await updateSettings({ closeBehavior: next });
    },
    [updateSettings]
  );
  const {
    closeBehavior,
    isCloseChoiceOpen,
    onCancelCloseChoice,
    handleWindowAction,
    requestClose,
    resolveCloseChoice
  } = useWindowBehavior({
    closeBehavior: appSettings.closeBehavior,
    setCloseBehavior
  });
  const scanManager = useScanManager({
    t,
    loadStats,
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

  if (databaseError) {
    return <DatabaseUnavailableState message={databaseError} toast={toast} />;
  }

  return (
    <AppShell
      {...appChrome}
      {...scanManager}
      {...operationQueue}
      language={language}
      setLanguage={setLanguage}
      theme={theme}
      setTheme={setTheme}
      view={view}
      setView={setView}
      searchQuery={searchQuery}
      setSearchQuery={setSearchQuery}
      stats={stats}
      libraryPage={libraryPage}
      setLibraryPage={setLibraryPage}
      selectedFile={selectedFile}
      setSelectedFileId={setSelectedFileId}
      files={files}
      rules={rules}
      saveRule={saveRule}
      toggleRuleEnabled={toggleRuleEnabled}
      deleteRule={deleteRule}
      toast={toast}
      closeBehavior={closeBehavior}
      setCloseBehavior={setCloseBehavior}
      isCloseChoiceOpen={isCloseChoiceOpen}
      onCancelCloseChoice={onCancelCloseChoice}
      handleWindowAction={handleWindowAction}
      resolveCloseChoice={resolveCloseChoice}
      loadStats={loadStats}
      t={t}
    />
  );
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
