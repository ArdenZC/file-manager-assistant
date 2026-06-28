import { useState, type KeyboardEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderPlus, Keyboard, Play, Trash2 } from "lucide-react";
import { useChromeContext, useSettingsContext } from "../../contexts/AppContexts";
import {
  removeDefaultScanRoot,
  toggleDefaultScanRoot,
  upsertDefaultScanRoot
} from "../../hooks/useAppSettings";
import { useScanManagerStore } from "../../store/useScanManagerStore";
import { useAppStore } from "../../store/useAppStore";
import type { CloseBehavior, FolderNamingLanguage, RestoreRetentionDays, ScanRootSetting } from "../../types/domain";
import { acceleratorFromKeyboardEvent, formatHotkeyLabel, isValidSearchHotkey } from "../../utils/hotkeys";
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
      launchAtLogin,
      searchHotkey
    },
    setFolderNamingLanguage,
    setDefaultScanFolders,
    setRestoreRetentionDays,
    setLaunchAtLogin,
    setSearchHotkey
  } = useSettingsContext();
  const scanPath = useScanManagerStore((state) => state.scanPath);
  const globalHotkeyError = useAppStore((state) => state.globalHotkeyError);
  const hotkey = formatHotkeyLabel(searchHotkey, platform);
  const [settingsStatus, setSettingsStatus] = useState("");
  const [isRecordingHotkey, setIsRecordingHotkey] = useState(false);

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

  async function addDefaultScanFolder() {
    const selectedPath = await open({
      directory: true,
      multiple: false,
      title: t("folderPickerTitle")
    });
    const path = Array.isArray(selectedPath) ? selectedPath[0] : selectedPath;
    if (!path?.trim()) return;

    const saved = await setDefaultScanFolders(upsertDefaultScanRoot(defaultScanFolders, path));
    if (saved) {
      setSettingsStatus(`${t("settingSaved")} · ${t("defaultScanFoldersRestartHint")}`);
    }
  }

  async function setScanRootEnabled(root: ScanRootSetting, enabled: boolean) {
    const saved = await setDefaultScanFolders(toggleDefaultScanRoot(defaultScanFolders, root.id, enabled));
    if (saved) {
      setSettingsStatus(`${t("settingSaved")} · ${t("defaultScanFoldersRestartHint")}`);
    }
  }

  async function deleteScanRoot(root: ScanRootSetting) {
    const saved = await setDefaultScanFolders(removeDefaultScanRoot(defaultScanFolders, root.id));
    if (saved) {
      setSettingsStatus(`${t("settingSaved")} · ${t("defaultScanFoldersRestartHint")}`);
    }
  }

  async function scanRootNow(root: ScanRootSetting) {
    await scanPath(root.path);
  }

  async function updateRestoreRetentionDays(next: RestoreRetentionDays) {
    const saved = await setRestoreRetentionDays(next);
    if (saved) {
      setSettingsStatus(t("settingSaved"));
    }
  }

  async function updateSearchHotkey(next: string) {
    if (!isValidSearchHotkey(next)) {
      setSettingsStatus(t("hotkeyInvalid"));
      return;
    }

    const saved = await setSearchHotkey(next);
    if (saved) {
      setSettingsStatus(`${t("hotkeySaved")} · ${t("hotkeyRestartHint")}`);
      setIsRecordingHotkey(false);
    }
  }

  function handleHotkeyRecording(event: KeyboardEvent<HTMLDivElement>) {
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Escape") {
      setIsRecordingHotkey(false);
      return;
    }

    const accelerator = acceleratorFromKeyboardEvent(event.nativeEvent, platform);
    if (!accelerator) {
      setSettingsStatus(t("hotkeyInvalid"));
      return;
    }
    void updateSearchHotkey(accelerator);
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
          <div className="flex items-start justify-between gap-3">
            <div><strong className="block text-sm">{t("defaultScanFolders")}</strong><span className={mutedText}>{t("defaultScanFoldersDesc")}</span></div>
            <button className={segmentButton(false)} onClick={() => void addDefaultScanFolder()}>
              <FolderPlus size={15} />
              <span>{t("addScanFolder")}</span>
            </button>
          </div>
          <div className="grid gap-2">
            {defaultScanFolders.length ? defaultScanFolders.map((root) => (
              <div key={root.id} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] items-center gap-2 rounded-xl border border-[var(--line-dark)] bg-white/20 px-3 py-2 dark:bg-white/5">
                <div className="min-w-0 text-left">
                  <strong className="block truncate text-sm">{root.label}</strong>
                  <span className="block truncate text-xs text-[var(--muted)]">{root.path}</span>
                </div>
                <button className={toggleSwitch(root.enabled)} onClick={() => void setScanRootEnabled(root, !root.enabled)} aria-label={root.enabled ? t("disableScanFolder") : t("enableScanFolder")}><i /></button>
                <button className={segmentButton(false)} onClick={() => void scanRootNow(root)} title={t("scanNow")}>
                  <Play size={14} />
                  <span>{t("scanNow")}</span>
                </button>
                <button className={segmentButton(false)} onClick={() => void deleteScanRoot(root)} title={t("deleteScanFolder")}>
                  <Trash2 size={14} />
                </button>
              </div>
            )) : (
              <div className="rounded-xl border border-dashed border-[var(--line-dark)] px-3 py-4 text-sm text-[var(--muted)]">{t("noDefaultScanFolders")}</div>
            )}
          </div>
          <span className={quietText}>{t("defaultScanFoldersRestartHint")}</span>
        </div>
        <div className="grid gap-3 rounded-2xl border border-[var(--line)] bg-white/20 p-3 dark:bg-white/5">
          <div className="flex items-center justify-between gap-4">
            <div><strong className="block text-sm">{t("searchHotkey")}</strong><span className={mutedText}>{t("searchHotkeyDesc")}</span></div>
            <span className="rounded-xl border border-[var(--line)] bg-white/25 px-3 py-1.5 text-sm font-medium text-[var(--ink)] dark:bg-white/5">{hotkey}</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className={segmentButton(isRecordingHotkey)} onClick={() => setIsRecordingHotkey(true)}>
              <Keyboard size={14} />
              <span>{t("changeHotkey")}</span>
            </button>
            {["CmdOrCtrl+K", "CmdOrCtrl+Shift+K", "Alt+Space", "CmdOrCtrl+Alt+Space"].map((accelerator) => (
              <button
                className={segmentButton(searchHotkey === accelerator)}
                key={accelerator}
                onClick={() => void updateSearchHotkey(accelerator)}
              >
                {formatHotkeyLabel(accelerator, platform)}
              </button>
            ))}
          </div>
          {isRecordingHotkey && (
            <div
              className="rounded-xl border border-dashed border-blue-400/60 bg-blue-500/10 px-3 py-3 text-sm text-blue-700 outline-none dark:text-blue-200"
              tabIndex={0}
              onKeyDown={handleHotkeyRecording}
            >
              {t("recordingHotkey")}
            </div>
          )}
          <span className={quietText}>{globalHotkeyError ? t("hotkeyConflictHint") : t("hotkeyRestartHint")}</span>
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

