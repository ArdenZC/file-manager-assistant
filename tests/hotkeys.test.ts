import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEARCH_HOTKEY,
  acceleratorFromKeyboardEvent,
  formatHotkeyLabel,
  isValidSearchHotkey,
  matchesAcceleratorEvent
} from "../src/utils/hotkeys";
import { DEFAULT_APP_SETTINGS } from "../src/hooks/useAppSettings";

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    preventDefault: () => {},
    ...init
  } as KeyboardEvent;
}

describe("search hotkeys", () => {
  it("defaults to a single CmdOrCtrl K accelerator", () => {
    expect(DEFAULT_SEARCH_HOTKEY).toBe("CmdOrCtrl+K");
    expect(DEFAULT_APP_SETTINGS.searchHotkey).toBe("CmdOrCtrl+K");
  });

  it("formats CmdOrCtrl labels by platform", () => {
    expect(formatHotkeyLabel("CmdOrCtrl+K", "darwin")).toBe("⌘ K");
    expect(formatHotkeyLabel("CmdOrCtrl+K", "win32")).toBe("Ctrl K");
    expect(formatHotkeyLabel("CmdOrCtrl+K", "linux")).toBe("Ctrl K");
    expect(formatHotkeyLabel("Ctrl+Shift+K", "win32")).toBe("Ctrl Shift K");
    expect(formatHotkeyLabel("Alt+Space", "win32")).toBe("Alt Space");
  });

  it("matches the configured accelerator from KeyboardEvent modifiers", () => {
    expect(matchesAcceleratorEvent(keyEvent({ key: "k", ctrlKey: true }), "CmdOrCtrl+K", "win32")).toBe(true);
    expect(matchesAcceleratorEvent(keyEvent({ key: "k", metaKey: true }), "CmdOrCtrl+K", "darwin")).toBe(true);
    expect(matchesAcceleratorEvent(keyEvent({ key: "k", shiftKey: true }), "CmdOrCtrl+K", "win32")).toBe(false);
    expect(matchesAcceleratorEvent(keyEvent({ key: " ", altKey: true }), "Alt+Space", "win32")).toBe(true);
  });

  it("rejects invalid recorded hotkeys", () => {
    expect(isValidSearchHotkey("K")).toBe(false);
    expect(isValidSearchHotkey("Enter")).toBe(false);
    expect(isValidSearchHotkey("Ctrl+Enter")).toBe(false);
    expect(isValidSearchHotkey("CmdOrCtrl+K")).toBe(true);
    expect(isValidSearchHotkey("Alt+Space")).toBe(true);
  });

  it("records valid accelerators from keyboard events", () => {
    expect(acceleratorFromKeyboardEvent(keyEvent({ key: "k", ctrlKey: true }), "win32")).toBe("CmdOrCtrl+K");
    expect(acceleratorFromKeyboardEvent(keyEvent({ key: "k", metaKey: true }), "darwin")).toBe("CmdOrCtrl+K");
    expect(acceleratorFromKeyboardEvent(keyEvent({ key: "Escape" }), "win32")).toBeNull();
    expect(acceleratorFromKeyboardEvent(keyEvent({ key: "k" }), "win32")).toBeNull();
  });
});
