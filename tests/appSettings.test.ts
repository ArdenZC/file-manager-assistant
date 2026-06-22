import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_APP_SETTINGS,
  createScanRootSetting,
  enabledScanRootPaths,
  mergeAppSettings,
  removeDefaultScanRoot,
  toggleDefaultScanRoot,
  upsertDefaultScanRoot
} from "../src/hooks/useAppSettings";

describe("app settings helpers", () => {
  it("matches the backend default settings shape", () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({
      closeBehavior: "ask",
      folderNamingLanguage: "en",
      defaultScanFolders: [],
      restoreRetentionDays: 30,
      launchAtLogin: false
    });
  });

  it("merges partial settings without mutating the previous object", () => {
    const previous = DEFAULT_APP_SETTINGS;

    const next = mergeAppSettings(previous, {
      defaultScanFolders: [
        createScanRootSetting("F:/Downloads", "2026-06-22T00:00:00.000Z")
      ],
      restoreRetentionDays: 90
    });

    expect(next).toEqual({
      closeBehavior: "ask",
      folderNamingLanguage: "en",
      defaultScanFolders: [
        {
          id: "scan-root-f-downloads",
          path: "F:/Downloads",
          label: "Downloads",
          enabled: true,
          createdAt: "2026-06-22T00:00:00.000Z"
        }
      ],
      restoreRetentionDays: 90,
      launchAtLogin: false
    });
    expect(previous.defaultScanFolders).toEqual([]);
  });

  it("adds, disables, removes, and lists arbitrary default scan roots", () => {
    const createdAt = "2026-06-22T00:00:00.000Z";
    const downloads = createScanRootSetting("F:/Downloads", createdAt);
    const projects = createScanRootSetting("D:/Work/Projects", createdAt);
    const roots = upsertDefaultScanRoot([downloads], "D:/Work/Projects", createdAt);
    const disabled = toggleDefaultScanRoot(roots, projects.id, false);

    expect(roots).toEqual([downloads, projects]);
    expect(enabledScanRootPaths(disabled)).toEqual(["F:/Downloads"]);
    expect(upsertDefaultScanRoot(disabled, "d:/work/projects", createdAt)[1].enabled).toBe(true);
    expect(removeDefaultScanRoot(roots, downloads.id)).toEqual([projects]);
  });

  it("restarts the backend file watcher when saved scan roots change", () => {
    const settingsSource = readFileSync(resolve("src-tauri/src/settings.rs"), "utf8");
    const mainSource = readFileSync(resolve("src-tauri/src/main.rs"), "utf8");
    const i18nSource = readFileSync(resolve("src/i18n.ts"), "utf8");

    expect(mainSource).toContain("FileWatcherManager::default()");
    expect(mainSource).toContain("reload_file_watcher_for_settings");
    expect(settingsSource).toContain("watcher_manager: State<'_, FileWatcherManager>");
    expect(settingsSource).toContain("reload_file_watcher_for_settings");
    expect(i18nSource).not.toContain("file watching updates after restarting the app");
    expect(i18nSource).not.toContain("文件监听会在重启应用后更新");
  });
});
