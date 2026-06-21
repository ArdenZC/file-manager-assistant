import { beforeEach, describe, expect, it, vi } from "vitest";
import { performCloseBehavior, performWindowAction } from "../src/hooks/useWindowBehavior";

const tauriWindowMock = vi.hoisted(() => {
  const currentWindow = {
    hide: vi.fn(async () => undefined),
    minimize: vi.fn(async () => undefined),
    maximize: vi.fn(async () => undefined),
    unmaximize: vi.fn(async () => undefined),
    isMaximized: vi.fn(async () => false),
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
    tauriWindowMock.currentWindow.hide.mockResolvedValue(undefined);
    tauriWindowMock.currentWindow.minimize.mockResolvedValue(undefined);
    tauriWindowMock.currentWindow.maximize.mockResolvedValue(undefined);
    tauriWindowMock.currentWindow.unmaximize.mockResolvedValue(undefined);
    tauriWindowMock.currentWindow.isMaximized.mockResolvedValue(false);
    tauriCoreMock.invoke.mockResolvedValue(undefined);
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

  it("reports hide failures when minimizing to background", async () => {
    const setIsCloseChoiceOpen = vi.fn();
    const onError = vi.fn();
    const error = new Error("ACL denied");
    tauriWindowMock.currentWindow.hide.mockRejectedValueOnce(error);

    performCloseBehavior("minimize", setIsCloseChoiceOpen, onError);
    await Promise.resolve();
    await Promise.resolve();

    expect(onError).toHaveBeenCalledWith(error);
  });

  it("reports window action failures", async () => {
    const requestClose = vi.fn();
    const onError = vi.fn();
    const error = new Error("Command core:window|allow-minimize not allowed by ACL");
    tauriWindowMock.currentWindow.minimize.mockRejectedValueOnce(error);

    await performWindowAction("minimize", requestClose, onError);

    expect(onError).toHaveBeenCalledWith(error);
    expect(requestClose).not.toHaveBeenCalled();
  });
});
