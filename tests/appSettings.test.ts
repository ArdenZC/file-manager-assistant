import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DEFAULT_APP_SETTINGS,
  createSearchRootSetting,
  createScanRootSetting,
  enabledScanRootPaths,
  enabledSearchRootPaths,
  mergeAppSettings,
  removeSearchRoot,
  removeDefaultScanRoot,
  resolveEffectiveSearchScope,
  toggleSearchRoot,
  toggleDefaultScanRoot,
  upsertSearchRoot,
  upsertDefaultScanRoot
} from "../src/hooks/useAppSettings";

describe("app settings helpers", () => {
  it("matches the backend default settings shape", () => {
    expect(DEFAULT_APP_SETTINGS).toEqual({
      closeBehavior: "ask",
      folderNamingLanguage: "en",
      defaultScanFolders: [],
      restoreRetentionDays: 30,
      launchAtLogin: false,
      searchHotkey: "CmdOrCtrl+K",
      searchScopeMode: "all",
      customSearchRoots: []
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
      launchAtLogin: false,
      searchHotkey: "CmdOrCtrl+K",
      searchScopeMode: "all",
      customSearchRoots: []
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

  it("adds, disables, removes, and lists custom search roots", () => {
    const createdAt = "2026-06-22T00:00:00.000Z";
    const downloads = createSearchRootSetting("F:/Downloads", createdAt);
    const projects = createSearchRootSetting("D:/Work/Projects", createdAt);
    const roots = upsertSearchRoot([downloads], "D:/Work/Projects", createdAt);
    const disabled = toggleSearchRoot(roots, projects.id, false);

    expect(roots).toEqual([downloads, projects]);
    expect(enabledSearchRootPaths(disabled)).toEqual(["F:/Downloads"]);
    expect(upsertSearchRoot(disabled, "d:/work/projects", createdAt)[1].enabled).toBe(true);
    expect(removeSearchRoot(roots, downloads.id)).toEqual([projects]);
  });

  it("resolves command search scope without mutating the library scope", () => {
    const currentScanScope = { kind: "current_scan" as const, roots: ["F:/Inbox"], scanSessionId: "scan-1" };
    const rootsScope = { kind: "roots" as const, roots: ["F:/Library"] };
    const allSettings = { ...DEFAULT_APP_SETTINGS, searchScopeMode: "all" as const };
    const currentSettings = { ...DEFAULT_APP_SETTINGS, searchScopeMode: "current_scan" as const };
    const customSettings = {
      ...DEFAULT_APP_SETTINGS,
      searchScopeMode: "custom_roots" as const,
      customSearchRoots: [
        createSearchRootSetting("D:/Downloads", "2026-06-22T00:00:00.000Z"),
        { ...createSearchRootSetting("E:/Archive", "2026-06-22T00:00:00.000Z"), enabled: false }
      ]
    };

    expect(resolveEffectiveSearchScope(allSettings, currentScanScope)).toEqual({ kind: "all" });
    expect(resolveEffectiveSearchScope(currentSettings, currentScanScope)).toEqual(currentScanScope);
    expect(resolveEffectiveSearchScope(currentSettings, { kind: "all" })).toEqual({
      kind: "current_scan",
      roots: []
    });
    expect(resolveEffectiveSearchScope(currentSettings, rootsScope)).toEqual({
      kind: "current_scan",
      roots: []
    });
    expect(resolveEffectiveSearchScope(customSettings, currentScanScope)).toEqual({
      kind: "roots",
      roots: ["D:/Downloads"]
    });
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

  it("surfaces persisted global hotkey registration status in settings", () => {
    const appControlSource = readFileSync(resolve("src-tauri/src/app_control.rs"), "utf8");
    const mainSource = readFileSync(resolve("src-tauri/src/main.rs"), "utf8");
    const settingsViewSource = readFileSync(resolve("src/views/settings/SettingsView.tsx"), "utf8");
    const runtimeProvidersSource = readFileSync(resolve("src/components/AppRuntimeProviders.tsx"), "utf8");

    expect(appControlSource).toContain("get_global_hotkey_status");
    expect(appControlSource).toContain("register_global_search_hotkey");
    expect(mainSource).toContain("GlobalHotkeyStatusState::default()");
    expect(mainSource).toContain("get_global_hotkey_status");
    expect(mainSource).toContain("register_global_search_hotkey");
    expect(settingsViewSource).toContain("getGlobalHotkeyStatus");
    expect(runtimeProvidersSource).toContain("registerGlobalSearchHotkey");
  });
});
