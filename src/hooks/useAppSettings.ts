import { useCallback, useEffect, useState } from "react";
import { tauriApi } from "../api/tauriApi";
import type { AppSettings, ScanRootSetting } from "../types/domain";
import { DEFAULT_SEARCH_HOTKEY } from "../utils/hotkeys";
import { readableError } from "../utils/viewHelpers";

const defaultFormatSettingsError = (error: unknown) => readableError(error);

export const DEFAULT_APP_SETTINGS: AppSettings = {
  closeBehavior: "ask",
  folderNamingLanguage: "en",
  defaultScanFolders: [],
  restoreRetentionDays: 30,
  launchAtLogin: false,
  searchHotkey: DEFAULT_SEARCH_HOTKEY
};

interface UseAppSettingsOptions {
  isDatabaseReady: boolean;
  onError: (message: string) => void;
  formatLoadError?: (error: unknown) => string;
  formatSaveError?: (error: unknown) => string;
}

export function mergeAppSettings(
  settings: AppSettings,
  partial: Partial<AppSettings>
): AppSettings {
  return {
    ...settings,
    ...partial
  };
}

export function createScanRootSetting(
  path: string,
  createdAt = new Date().toISOString()
): ScanRootSetting {
  const normalizedPath = normalizeScanRootPath(path);
  return {
    id: scanRootId(normalizedPath),
    path: normalizedPath,
    label: scanRootLabel(normalizedPath),
    enabled: true,
    createdAt
  };
}

export function upsertDefaultScanRoot(
  current: ScanRootSetting[],
  path: string,
  createdAt = new Date().toISOString()
): ScanRootSetting[] {
  const nextRoot = createScanRootSetting(path, createdAt);
  const existingIndex = current.findIndex((root) => sameScanRootPath(root.path, nextRoot.path));

  if (existingIndex === -1) return [...current, nextRoot];

  return current.map((root, index) =>
    index === existingIndex
      ? {
          ...root,
          path: nextRoot.path,
          label: root.label || nextRoot.label,
          enabled: true
        }
      : root
  );
}

export function toggleDefaultScanRoot(
  current: ScanRootSetting[],
  id: string,
  enabled: boolean
): ScanRootSetting[] {
  return current.map((root) => (root.id === id ? { ...root, enabled } : root));
}

export function removeDefaultScanRoot(
  current: ScanRootSetting[],
  id: string
): ScanRootSetting[] {
  return current.filter((root) => root.id !== id);
}

export function enabledScanRootPaths(roots: ScanRootSetting[]): string[] {
  return roots
    .filter((root) => root.enabled && root.path.trim())
    .map((root) => root.path.trim());
}

function normalizeScanRootPath(path: string) {
  return path.trim().replace(/\\+/g, "/").replace(/\/+$/g, "");
}

function sameScanRootPath(left: string, right: string) {
  return normalizeScanRootPath(left).toLowerCase() === normalizeScanRootPath(right).toLowerCase();
}

function scanRootLabel(path: string) {
  const normalizedPath = normalizeScanRootPath(path);
  const segments = normalizedPath.split("/").filter(Boolean);
  return segments.at(-1) || normalizedPath;
}

function scanRootId(path: string) {
  const normalizedPath = normalizeScanRootPath(path).toLowerCase();
  const slug = normalizedPath
    .replace(/^[a-z]:/i, (drive) => drive[0] ?? "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `scan-root-${slug || "root"}`;
}

export function useAppSettings({
  isDatabaseReady,
  onError,
  formatLoadError = defaultFormatSettingsError,
  formatSaveError = defaultFormatSettingsError
}: UseAppSettingsOptions) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_APP_SETTINGS);
  const [isLoadingSettings, setIsLoadingSettings] = useState(false);

  useEffect(() => {
    if (!isDatabaseReady) return;

    let cancelled = false;

    async function loadSettings() {
      setIsLoadingSettings(true);
      try {
        const loadedSettings = await tauriApi.getSettings();
        if (!cancelled) {
          setSettings(loadedSettings);
        }
      } catch (error) {
        if (!cancelled) {
          onError(formatLoadError(error));
        }
      } finally {
        if (!cancelled) {
          setIsLoadingSettings(false);
        }
      }
    }

    void loadSettings();

    return () => {
      cancelled = true;
    };
  }, [formatLoadError, isDatabaseReady, onError]);

  const updateSettings = useCallback(
    async (partial: Partial<AppSettings>) => {
      const previousSettings = settings;
      const nextSettings = mergeAppSettings(previousSettings, partial);

      setSettings(nextSettings);

      try {
        const savedSettings = await tauriApi.saveSettings(nextSettings);
        setSettings(savedSettings);
        return savedSettings;
      } catch (error) {
        setSettings(previousSettings);
        onError(formatSaveError(error));
        return previousSettings;
      }
    },
    [formatSaveError, onError, settings]
  );

  return {
    settings,
    isLoadingSettings,
    updateSettings
  };
}
