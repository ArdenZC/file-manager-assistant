import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { tauriApi } from "../api/tauriApi";
import { ChromeProvider, RulesProvider, SettingsProvider } from "../contexts/AppContexts";
import { useAppChrome } from "../hooks/useAppChrome";
import { useAppSettings } from "../hooks/useAppSettings";
import { useFsWatcher } from "../hooks/useFsWatcher";
import { useRulePersistence } from "../hooks/useRulePersistence";
import { useWindowBehavior } from "../hooks/useWindowBehavior";
import { makeTranslator } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { useFileLibraryStore } from "../store/useFileLibraryStore";
import { useOperationQueueStore } from "../store/useOperationQueueStore";
import { persistRuleEnabledToggle, persistUserRuleDelete } from "../store/rulePersistence";
import { useRulesStore } from "../store/useRulesStore";
import { useScanManagerStore } from "../store/useScanManagerStore";
import type {
  CloseBehavior,
  FolderNamingLanguage,
  RestoreRetentionDays,
  ScanRootSetting,
  SearchRootSetting,
  SearchScopeMode,
  Rule
} from "../types/domain";
import { applySearchNavigation } from "../utils/searchNavigation";
import { readableError } from "../utils/viewHelpers";

export function AppRuntimeProviders({ children }: { children: ReactNode }) {
  const language = useAppStore((state) => state.language);
  const setLanguage = useAppStore((state) => state.setLanguage);
  const theme = useAppStore((state) => state.theme);
  const setTheme = useAppStore((state) => state.setTheme);
  const view = useAppStore((state) => state.view);
  const setView = useAppStore((state) => state.setView);
  const showSuccess = useAppStore((state) => state.showSuccess);
  const showError = useAppStore((state) => state.showError);
  const rules = useRulesStore((state) => state.rules);
  const upsertRule = useRulesStore((state) => state.upsertRule);
  const removeUserRule = useRulesStore((state) => state.removeUserRule);
  const hydrateUserRulesFromSQLite = useRulesStore((state) => state.hydrateUserRulesFromSQLite);
  const t = useMemo(() => makeTranslator(language), [language]);
  const refreshCurrentQuery = useCallback(
    () => useFileLibraryStore.getState().refresh(useAppStore.getState().searchQuery),
    []
  );
  const formatSettingsLoadError = useCallback(
    (error: unknown) => `${t("settingsLoadFailed")}：${readableError(error)}`,
    [t]
  );
  const formatSettingsSaveError = useCallback(
    (error: unknown) => `${t("settingsSaveFailed")}：${readableError(error)}`,
    [t]
  );
  const reportWindowActionError = useCallback(
    (error: unknown) => showError(`${t("windowActionFailed")}：${readableError(error)}`),
    [showError, t]
  );

  useRulePersistence({
    isDatabaseReady: true,
    rules,
    hydrateUserRulesFromSQLite,
    onError: showError
  });
  const appSettingsState = useAppSettings({
    isDatabaseReady: true,
    onError: showError,
    formatLoadError: formatSettingsLoadError,
    formatSaveError: formatSettingsSaveError
  });
  const { settings: appSettings, isLoadingSettings, updateSettings } = appSettingsState;
  useFsWatcher({ onRefreshData: refreshCurrentQuery, onError: showError, rules });

  useEffect(() => {
    useScanManagerStore.getState().setDefaultScanRoots(appSettings.defaultScanFolders);
  }, [appSettings.defaultScanFolders]);

  const appChrome = useAppChrome({
    theme,
    setTheme,
    setLanguage,
    searchHotkey: appSettings.searchHotkey
  });
  const {
    commandInputRef,
    isCommandOpen,
    setIsCommandOpen,
    platform,
    isWindows,
    effectiveTheme,
    hotkeyLabel,
    isSearchMode
  } = appChrome;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void tauriApi.onSearchNavigate((payload) => {
      applySearchNavigation(payload, setView, useFileLibraryStore.getState().setSelectedFileId);
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
  }, [setView, showError]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    void tauriApi.onGlobalHotkeyRegistrationFailed((payload) => {
      useAppStore.getState().setGlobalHotkeyError(payload.message);
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
  }, [showError]);

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
    async (next: ScanRootSetting[]) => {
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
  const setSearchHotkey = useCallback(
    async (next: string) => {
      const savedSettings = await updateSettings({ searchHotkey: next });
      const saved = savedSettings.searchHotkey === next;
      if (saved) {
        try {
          const status = await tauriApi.registerGlobalSearchHotkey(next);
          useAppStore.getState().setGlobalHotkeyError(status.error ?? "");
        } catch (error) {
          useAppStore.getState().setGlobalHotkeyError(readableError(error));
        }
      }
      return saved;
    },
    [updateSettings]
  );
  const setSearchScopeMode = useCallback(
    async (next: SearchScopeMode) => {
      const savedSettings = await updateSettings({ searchScopeMode: next });
      return savedSettings.searchScopeMode === next;
    },
    [updateSettings]
  );
  const setCustomSearchRoots = useCallback(
    async (next: SearchRootSetting[]) => {
      const savedSettings = await updateSettings({ customSearchRoots: next });
      return arraysEqual(savedSettings.customSearchRoots, next);
    },
    [updateSettings]
  );
  const windowBehavior = useWindowBehavior({
    closeBehavior: appSettings.closeBehavior,
    setCloseBehavior,
    onError: reportWindowActionError
  });
  const {
    closeBehavior,
    isCloseChoiceOpen,
    onCancelCloseChoice,
    handleWindowAction,
    requestClose,
    resolveCloseChoice
  } = windowBehavior;

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
    setLaunchAtLogin,
    setSearchHotkey,
    setSearchScopeMode,
    setCustomSearchRoots
  }), [
    appSettings,
    isLoadingSettings,
    updateSettings,
    setFolderNamingLanguage,
    setDefaultScanFolders,
    setRestoreRetentionDays,
    setLaunchAtLogin,
    setSearchHotkey,
    setSearchScopeMode,
    setCustomSearchRoots
  ]);
  const rulesContextValue = useMemo(() => ({
    rules,
    saveRule,
    toggleRuleEnabled,
    deleteRule
  }), [deleteRule, rules, saveRule, toggleRuleEnabled]);
  const chromeContextValue = useMemo(() => ({
    commandInputRef,
    isCommandOpen,
    setIsCommandOpen,
    platform,
    isWindows,
    effectiveTheme,
    hotkeyLabel,
    isSearchMode,
    closeBehavior,
    setCloseBehavior,
    isCloseChoiceOpen,
    onCancelCloseChoice,
    handleWindowAction,
    requestClose,
    resolveCloseChoice,
    language,
    setLanguage,
    theme,
    setTheme,
    view,
    setView,
    onError: showError,
    t
  }), [
    commandInputRef,
    isCommandOpen,
    setIsCommandOpen,
    platform,
    isWindows,
    effectiveTheme,
    hotkeyLabel,
    isSearchMode,
    closeBehavior,
    setCloseBehavior,
    isCloseChoiceOpen,
    onCancelCloseChoice,
    handleWindowAction,
    requestClose,
    resolveCloseChoice,
    language,
    setLanguage,
    theme,
    setTheme,
    view,
    setView,
    showError,
    t
  ]);

  return (
    <ChromeProvider value={chromeContextValue}>
      <StoreRuntimeBootstrapper />
      <SettingsProvider value={settingsContextValue}>
        <RulesProvider value={rulesContextValue}>{children}</RulesProvider>
      </SettingsProvider>
    </ChromeProvider>
  );
}

function StoreRuntimeBootstrapper() {
  const initializeScanListeners = useScanManagerStore((state) => state.initializeScanListeners);
  const initializeOperationQueue = useOperationQueueStore((state) => state.initializeOperationQueue);

  useEffect(() => {
    void useFileLibraryStore.getState().refresh(useAppStore.getState().searchQuery);
    void initializeScanListeners();
    void initializeOperationQueue();
  }, [initializeOperationQueue, initializeScanListeners]);

  return null;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]) {
  return JSON.stringify(left) === JSON.stringify(right);
}
