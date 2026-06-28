import { createContext, useContext, type ReactNode } from "react";
import type { Language } from "../i18n";
import type { useAppChrome } from "../hooks/useAppChrome";
import type { useAppSettings } from "../hooks/useAppSettings";
import type { useWindowBehavior } from "../hooks/useWindowBehavior";
import type {
  FolderNamingLanguage,
  RestoreRetentionDays,
  ScanRootSetting,
  Rule
} from "../types/domain";
import type { ThemeMode, Translator, View } from "../types/ui";

type ProviderProps<T> = {
  value: T;
  children: ReactNode;
};

export type AppSettingsContextState = ReturnType<typeof useAppSettings>;

export interface SettingsContextValue extends AppSettingsContextState {
  setFolderNamingLanguage: (next: FolderNamingLanguage) => Promise<boolean>;
  setDefaultScanFolders: (next: ScanRootSetting[]) => Promise<boolean>;
  setRestoreRetentionDays: (next: RestoreRetentionDays) => Promise<boolean>;
  setLaunchAtLogin: (next: boolean) => Promise<boolean>;
  setSearchHotkey: (next: string) => Promise<boolean>;
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
  onError: (message: string) => void;
  t: Translator;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);
const RulesContext = createContext<RulesContextValue | null>(null);
const ChromeContext = createContext<ChromeContextValue | null>(null);

function useRequiredContext<T>(value: T | null, hookName: string, providerName: string): T {
  if (!value) throw new Error(`${hookName} must be used within ${providerName}.`);
  return value;
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
