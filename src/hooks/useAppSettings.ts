import { useCallback, useEffect, useState } from "react";
import { tauriApi } from "../api/tauriApi";
import type { AppSettings } from "../types/domain";
import { readableError } from "../utils/viewHelpers";

const defaultFormatSettingsError = (error: unknown) => readableError(error);

export const DEFAULT_APP_SETTINGS: AppSettings = {
  closeBehavior: "ask",
  folderNamingLanguage: "en",
  defaultScanFolders: ["Desktop", "Downloads", "Documents"],
  restoreRetentionDays: 30,
  launchAtLogin: false
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
