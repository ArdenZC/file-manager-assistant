import { useCallback, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { tauriApi } from "../api/tauriApi";
import type { CloseBehavior } from "../types/ui";

interface UseWindowBehaviorOptions {
  closeBehavior: CloseBehavior;
  setCloseBehavior: (next: CloseBehavior) => Promise<void>;
}

export async function hideToBackground() {
  await getCurrentWindow().hide();
}

export async function quitApp() {
  await tauriApi.quitApp();
}

export function performCloseBehavior(
  behavior: CloseBehavior,
  setCloseChoiceOpen: (open: boolean) => void
) {
  if (behavior === "ask") {
    setCloseChoiceOpen(true);
    return;
  }

  setCloseChoiceOpen(false);
  if (behavior === "minimize") void hideToBackground();
  if (behavior === "quit") void quitApp();
}

export function useWindowBehavior({
  closeBehavior,
  setCloseBehavior: persistCloseBehavior
}: UseWindowBehaviorOptions) {
  const [isCloseChoiceOpen, setIsCloseChoiceOpen] = useState(false);
  const closeBehaviorRef = useRef(closeBehavior);

  // 同步 ref（供 requestClose 使用，避免 stale closure）
  if (closeBehaviorRef.current !== closeBehavior) {
    closeBehaviorRef.current = closeBehavior;
  }

  const setCloseBehavior = useCallback(
    async (next: CloseBehavior) => {
      await persistCloseBehavior(next);
    },
    [persistCloseBehavior]
  );

  const requestClose = useCallback(() => {
    performCloseBehavior(closeBehaviorRef.current, setIsCloseChoiceOpen);
  }, []);

  const handleWindowAction = useCallback(
    async (action: "minimize" | "maximize" | "close") => {
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
    },
    [requestClose]
  );

  const resolveCloseChoice = useCallback(
    async (action: "minimize" | "quit", remember: boolean) => {
      if (remember) await setCloseBehavior(action);
      setIsCloseChoiceOpen(false);
      if (action === "quit") void quitApp();
      if (action === "minimize") void hideToBackground();
    },
    [setCloseBehavior]
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
