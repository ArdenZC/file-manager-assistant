import { beforeEach, describe, expect, it, vi } from "vitest";
import { performCloseBehavior } from "../src/hooks/useWindowBehavior";

const tauriWindowMock = vi.hoisted(() => {
  const currentWindow = {
    hide: vi.fn(async () => undefined),
    minimize: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined)
  };
  return {
    currentWindow,
    getCurrentWindow: vi.fn(() => currentWindow)
  };
});

const tauriCoreMock = vi.hoisted(() => ({
  invoke: vi.fn(async () => undefined)
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: tauriWindowMock.getCurrentWindow
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauriCoreMock.invoke
}));

describe("close behavior state machine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("opens the close choice dialog for ask", () => {
    const setIsCloseChoiceOpen = vi.fn();

    performCloseBehavior("ask", setIsCloseChoiceOpen);

    expect(setIsCloseChoiceOpen).toHaveBeenCalledWith(true);
    expect(tauriWindowMock.getCurrentWindow).not.toHaveBeenCalled();
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled();
  });

  it("hides the current window for minimize", async () => {
    const setIsCloseChoiceOpen = vi.fn();

    performCloseBehavior("minimize", setIsCloseChoiceOpen);
    await Promise.resolve();

    expect(setIsCloseChoiceOpen).toHaveBeenCalledWith(false);
    expect(tauriWindowMock.currentWindow.hide).toHaveBeenCalledOnce();
    expect(tauriWindowMock.currentWindow.minimize).not.toHaveBeenCalled();
    expect(tauriWindowMock.currentWindow.close).not.toHaveBeenCalled();
    expect(tauriCoreMock.invoke).not.toHaveBeenCalled();
  });

  it("invokes the app-level quit command for quit", async () => {
    const setIsCloseChoiceOpen = vi.fn();

    performCloseBehavior("quit", setIsCloseChoiceOpen);
    await Promise.resolve();

    expect(setIsCloseChoiceOpen).toHaveBeenCalledWith(false);
    expect(tauriCoreMock.invoke).toHaveBeenCalledWith("quit_app", undefined);
    expect(tauriWindowMock.getCurrentWindow).not.toHaveBeenCalled();
  });
});
