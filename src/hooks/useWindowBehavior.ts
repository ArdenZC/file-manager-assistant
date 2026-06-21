import { useCallback, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tauriApi } from "../api/tauriApi";
import type { CloseBehavior } from "../types/ui";

interface UseWindowBehaviorOptions {
  closeBehavior: CloseBehavior;
  setCloseBehavior: (next: CloseBehavior) => Promise<boolean>;
  onError?: (error: unknown) => void;
}

export async function hideToBackground(onError?: (error: unknown) => void) {
  try {
    await getCurrentWindow().hide();
  } catch (error) {
    onError?.(error);
  }
}

export async function quitApp(onError?: (error: unknown) => void) {
  try {
    await tauriApi.quitApp();
  } catch (error) {
    onError?.(error);
  }
}

export function performCloseBehavior(
  behavior: CloseBehavior,
  setCloseChoiceOpen: (open: boolean) => void,
  onError?: (error: unknown) => void
) {
  if (behavior === "ask") {
    setCloseChoiceOpen(true);
    return;
  }

  setCloseChoiceOpen(false);
  if (behavior === "minimize") void hideToBackground(onError);
  if (behavior === "quit") void quitApp(onError);
}

export async function performWindowAction(
  action: "minimize" | "maximize" | "close",
  requestClose: () => void,
  onError?: (error: unknown) => void
) {
  try {
    const win = getCurrentWindow();
    if (action === "minimize") {
      await win.minimize();
    } else if (action === "maximize") {
      const isMax = await win.isMaximized();
      if (isMax) {
        await win.unmaximize();
      } else {
        await win.maximize();
      }
    } else {
      requestClose();
    }
  } catch (error) {
    onError?.(error);
  }
}

export function useWindowBehavior({
  closeBehavior,
  setCloseBehavior: persistCloseBehavior,
  onError
}: UseWindowBehaviorOptions) {
  const [isCloseChoiceOpen, setIsCloseChoiceOpen] = useState(false);
  const closeBehaviorRef = useRef(closeBehavior);

  // 同步 ref（供 requestClose 使用，避免 stale closure）
  if (closeBehaviorRef.current !== closeBehavior) {
    closeBehaviorRef.current = closeBehavior;
  }

  const setCloseBehavior = useCallback(
    async (next: CloseBehavior) => {
      return persistCloseBehavior(next);
    },
    [persistCloseBehavior]
  );

  const requestClose = useCallback(() => {
    performCloseBehavior(closeBehaviorRef.current, setIsCloseChoiceOpen, onError);
  }, [onError]);

  const handleWindowAction = useCallback(
    async (action: "minimize" | "maximize" | "close") => {
      await performWindowAction(action, requestClose, onError);
    },
    [onError, requestClose]
  );

  const resolveCloseChoice = useCallback(
    async (action: "minimize" | "quit", remember: boolean) => {
      if (remember) await setCloseBehavior(action);
      setIsCloseChoiceOpen(false);
      if (action === "quit") void quitApp(onError);
      if (action === "minimize") void hideToBackground(onError);
    },
    [onError, setCloseBehavior]
  );

  return {
    closeBehavior,
    setCloseBehavior,
    isCloseChoiceOpen,
    onCancelCloseChoice: () => setIsCloseChoiceOpen(false),
    handleWindowAction,
    requestClose,
    resolveCloseChoice
  };
}
