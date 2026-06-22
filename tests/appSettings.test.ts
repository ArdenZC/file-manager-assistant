import { describe, expect, it } from "vitest";
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
});
