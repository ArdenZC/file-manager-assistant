import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { activateCommandNavigation } from "../src/components/CommandModal";
import { applySearchNavigation } from "../src/utils/searchNavigation";
import { DEFAULT_SEARCH_HOTKEY, formatHotkeyLabel } from "../src/utils/hotkeys";

describe("spotlight search navigation", () => {
  it("displays the registered global shortcut for each platform", () => {
    expect(DEFAULT_SEARCH_HOTKEY).toBe("CmdOrCtrl+K");
    expect(formatHotkeyLabel(DEFAULT_SEARCH_HOTKEY, "darwin")).toBe("⌘ K");
    expect(formatHotkeyLabel(DEFAULT_SEARCH_HOTKEY, "win32")).toBe("Ctrl K");
    expect(formatHotkeyLabel(DEFAULT_SEARCH_HOTKEY, "linux")).toBe("Ctrl K");
  });

  it("activates standalone search results through the backend command", async () => {
    const activateSearchResult = vi.fn(async () => {});
    const setView = vi.fn();
    const setSelectedFileId = vi.fn();
    const onClose = vi.fn();

    await activateCommandNavigation({
      standalone: true,
      view: "library",
      fileId: "file-1",
      setView,
      setSelectedFileId,
      onClose,
      activateSearchResult
    });

    expect(activateSearchResult).toHaveBeenCalledWith("library", "file-1");
    expect(setSelectedFileId).not.toHaveBeenCalled();
    expect(setView).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("keeps in-window command navigation local", async () => {
    const activateSearchResult = vi.fn(async () => {});
    const setView = vi.fn();
    const setSelectedFileId = vi.fn();
    const onClose = vi.fn();

    await activateCommandNavigation({
      standalone: false,
      view: "library",
      fileId: "file-1",
      setView,
      setSelectedFileId,
      onClose,
      activateSearchResult
    });

    expect(setSelectedFileId).toHaveBeenCalledWith("file-1");
    expect(setView).toHaveBeenCalledWith("library");
    expect(onClose).toHaveBeenCalledOnce();
    expect(activateSearchResult).not.toHaveBeenCalled();
  });

  it("applies search-navigate payloads to the main window state", () => {
    const setView = vi.fn();
    const setSelectedFileId = vi.fn();

    applySearchNavigation({ view: "library", fileId: "file-1" }, setView, setSelectedFileId);
    applySearchNavigation({ view: "preview", fileId: null }, setView, setSelectedFileId);

    expect(setView).toHaveBeenNthCalledWith(1, "library");
    expect(setSelectedFileId).toHaveBeenCalledWith("file-1");
    expect(setView).toHaveBeenNthCalledWith(2, "preview");
    expect(setSelectedFileId).toHaveBeenCalledTimes(1);
  });

  it("uses the resolved effective search scope for command and standalone spotlight results", () => {
    const commandModal = readFileSync(resolve("src/components/CommandModal.tsx"), "utf8");
    const appShell = readFileSync(resolve("src/components/AppShell.tsx"), "utf8");

    expect(commandModal).toContain("searchScope");
    expect(commandModal).toContain("tauriApi.searchFiles(trimmedSearch, 12, searchScope)");
    expect(commandModal).not.toContain("tauriApi.getPagedFiles(12, 0, trimmedSearch");
    expect(appShell).toContain("resolveEffectiveSearchScope");
    expect(appShell).toContain("searchScope={effectiveSearchScope}");
  });

  it("configures the global search window as a transparent spotlight surface", () => {
    const appControl = readFileSync(resolve("src-tauri/src/app_control.rs"), "utf8");
    const cargoToml = readFileSync(resolve("src-tauri/Cargo.toml"), "utf8");
    const tauriConfig = readFileSync(resolve("src-tauri/tauri.conf.json"), "utf8");
    const appShell = readFileSync(resolve("src/components/AppShell.tsx"), "utf8");
    const main = readFileSync(resolve("src/main.tsx"), "utf8");
    const styles = readFileSync(resolve("src/styles.css"), "utf8");

    const setupSearchWindow = appControl.slice(
      appControl.indexOf("pub fn setup_search_window"),
      appControl.indexOf("pub fn setup_global_search_shortcut")
    );

    expect(setupSearchWindow).toContain(".transparent(true)");
    expect(setupSearchWindow).not.toContain("target_os = \"windows\", target_os = \"linux\"");
    expect(cargoToml).toContain("\"tauri/macos-private-api\"");
    expect(tauriConfig).toContain("\"macOSPrivateApi\": true");
    expect(setupSearchWindow).toContain(".decorations(false)");
    expect(setupSearchWindow).toContain(".resizable(false)");
    expect(setupSearchWindow).toContain(".skip_taskbar(true)");
    expect(setupSearchWindow).toContain(".always_on_top(true)");
    expect(appShell).toContain("const searchWindowRoot =");
    expect(appShell).toContain("bg-transparent");
    expect(main).toContain("search-window-page");
    expect(styles).toContain("html.search-window-page");
    expect(styles).toContain("min-width: 0");
    expect(styles).toContain("background: transparent");
  });
});
