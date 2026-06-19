import { useCallback, useEffect, useMemo, useState } from "react";
import { tauriApi } from "./api/tauriApi";
import { AppShell } from "./components/AppShell";
import { makeTranslator } from "./i18n";
import { useAppChrome } from "./hooks/useAppChrome";
import { useDebounce } from "./hooks/useDebounce";
import { useFileLibrary } from "./hooks/useFileLibrary";
import { useFsWatcher } from "./hooks/useFsWatcher";
import { useOperationQueue } from "./hooks/useOperationQueue";
import { useScanManager } from "./hooks/useScanManager";
import { useWindowBehavior } from "./hooks/useWindowBehavior";
import { useAppStore } from "./store/useAppStore";
import { useRulesStore } from "./store/useRulesStore";
import type { Rule } from "./types/domain";

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
  const addRule = useRulesStore((state) => state.addRule);
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" | "info" } | null>(null);

  const t = useMemo(() => makeTranslator(language), [language]);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const showSuccess = useCallback((message: string) => setToast({ message, type: "success" }), []);
  const showError = useCallback((message: string) => setToast({ message, type: "error" }), []);
  const { stats, libraryPage, setLibraryPage, files, selectedFile, setSelectedFileId, loadStats, refresh } =
    useFileLibrary({
      debouncedSearchQuery,
      onError: showError
    });

  useEffect(() => {
    void tauriApi.initDatabase().catch(() => undefined);
    void refresh();
  }, [refresh]);
  useFsWatcher({ onRefreshData: refresh, onError: showError });

  const appChrome = useAppChrome({ theme, setTheme, setLanguage });
  const {
    closeBehavior,
    setCloseBehavior,
    isCloseChoiceOpen,
    onCancelCloseChoice,
    handleWindowAction,
    requestClose,
    resolveCloseChoice
  } = useWindowBehavior();
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

  const saveRule = useCallback(async (rule: Rule) => addRule(rule), [addRule]);

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
