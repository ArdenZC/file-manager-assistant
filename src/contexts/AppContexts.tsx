import { createContext, useContext, type ReactNode } from "react";
import type { Language } from "../i18n";
import type { useAppChrome } from "../hooks/useAppChrome";
import type { useAppSettings } from "../hooks/useAppSettings";
import type { useFileLibrary } from "../hooks/useFileLibrary";
import type { useOperationQueue } from "../hooks/useOperationQueue";
import type { useScanManager } from "../hooks/useScanManager";
import type { useWindowBehavior } from "../hooks/useWindowBehavior";
import type {
  DefaultScanFolder,
  FolderNamingLanguage,
  RestoreRetentionDays,
  Rule
} from "../types/domain";
import type { ThemeMode, Translator, View } from "../types/ui";

type ProviderProps<T> = {
  value: T;
  children: ReactNode;
};

export type ScanContextValue = ReturnType<typeof useScanManager>;
export type OperationQueueContextValue = ReturnType<typeof useOperationQueue>;
export type AppSettingsContextState = ReturnType<typeof useAppSettings>;
export type FileLibraryContextValue = ReturnType<typeof useFileLibrary>;

export interface SettingsContextValue extends AppSettingsContextState {
  setFolderNamingLanguage: (next: FolderNamingLanguage) => Promise<boolean>;
  setDefaultScanFolders: (next: DefaultScanFolder[]) => Promise<boolean>;
  setRestoreRetentionDays: (next: RestoreRetentionDays) => Promise<boolean>;
  setLaunchAtLogin: (next: boolean) => Promise<boolean>;
}

export interface RulesContextValue {
  rules: Rule[];
  saveRule: (rule: Rule) => Promise<void>;
  toggleRuleEnabled: (rule: Rule, enabled: boolean) => Promise<void>;
  deleteRule: (rule: Rule) => Promise<void>;
}

export interface ChromeContextValue extends ReturnType<typeof useAppChrome>, ReturnType<typeof useWindowBehavior> {
  language: Language;
  setLanguage: (language: Language) => void;
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  view: View;
  setView: (view: View) => void;
  searchQuery: string;
  setSearchQuery: (searchQuery: string) => void;
  toast: { message: string; type: "success" | "error" | "info" } | null;
  onError: (message: string) => void;
  t: Translator;
}

const ScanContext = createContext<ScanContextValue | null>(null);
const OperationQueueContext = createContext<OperationQueueContextValue | null>(null);
const SettingsContext = createContext<SettingsContextValue | null>(null);
const RulesContext = createContext<RulesContextValue | null>(null);
const ChromeContext = createContext<ChromeContextValue | null>(null);
const FileLibraryContext = createContext<FileLibraryContextValue | null>(null);

function useRequiredContext<T>(value: T | null, hookName: string, providerName: string): T {
  if (!value) throw new Error(`${hookName} must be used within ${providerName}.`);
  return value;
}

export function ScanProvider({ value, children }: ProviderProps<ScanContextValue>) {
  return <ScanContext.Provider value={value}>{children}</ScanContext.Provider>;
}

export function useScanContext() {
  return useRequiredContext(useContext(ScanContext), "useScanContext", "ScanProvider");
}

export function OperationQueueProvider({ value, children }: ProviderProps<OperationQueueContextValue>) {
  return <OperationQueueContext.Provider value={value}>{children}</OperationQueueContext.Provider>;
}

export function useOperationQueueContext() {
  return useRequiredContext(
    useContext(OperationQueueContext),
    "useOperationQueueContext",
    "OperationQueueProvider"
  );
}

export function SettingsProvider({ value, children }: ProviderProps<SettingsContextValue>) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettingsContext() {
  return useRequiredContext(useContext(SettingsContext), "useSettingsContext", "SettingsProvider");
}

export function RulesProvider({ value, children }: ProviderProps<RulesContextValue>) {
  return <RulesContext.Provider value={value}>{children}</RulesContext.Provider>;
}

export function useRulesContext() {
  return useRequiredContext(useContext(RulesContext), "useRulesContext", "RulesProvider");
}

export function ChromeProvider({ value, children }: ProviderProps<ChromeContextValue>) {
  return <ChromeContext.Provider value={value}>{children}</ChromeContext.Provider>;
}

export function useChromeContext() {
  return useRequiredContext(useContext(ChromeContext), "useChromeContext", "ChromeProvider");
}

export function FileLibraryProvider({ value, children }: ProviderProps<FileLibraryContextValue>) {
  return <FileLibraryContext.Provider value={value}>{children}</FileLibraryContext.Provider>;
}

export function useFileLibraryContext() {
  return useRequiredContext(
    useContext(FileLibraryContext),
    "useFileLibraryContext",
    "FileLibraryProvider"
  );
}
