import { useState } from "react";
import { useChromeContext, useSettingsContext } from "../../contexts/AppContexts";
import { nextDefaultScanFolders } from "../../hooks/useAppSettings";
import type { CloseBehavior, DefaultScanFolder, FolderNamingLanguage, RestoreRetentionDays } from "../../types/domain";
import { defaultPlatformAccelerator } from "../../utils/viewHelpers";
import { cn, statusToast } from "../../utils/tw";
import { mutedText, pageSurface, panelSurface, quietText, segmented, segmentButton, sourceBadge, toggleSwitch, SectionTitle } from "../shared/ui";

export function SettingsView() {
  const {
    language,
    setLanguage,
    theme,
    setTheme,
    platform,
    closeBehavior,
    setCloseBehavior,
    t
  } = useChromeContext();
  const {
    settings: {
      folderNamingLanguage,
      defaultScanFolders,
      restoreRetentionDays,
      launchAtLogin
    },
    setFolderNamingLanguage,
    setDefaultScanFolders,
    setRestoreRetentionDays,
    setLaunchAtLogin
  } = useSettingsContext();
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

