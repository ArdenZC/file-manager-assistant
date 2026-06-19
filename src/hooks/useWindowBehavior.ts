import { useCallback, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { CloseBehavior } from "../types/ui";

interface UseWindowBehaviorOptions {
  platform: NodeJS.Platform | "browser";
}

function readStoredBehavior(): CloseBehavior {
  const saved = window.localStorage.getItem("zc-close-behavior");
  return saved === "minimize" || saved === "quit" || saved === "ask" ? saved : "ask";
}

export function useWindowBehavior({ platform }: UseWindowBehaviorOptions) {
  const [closeBehavior, setCloseBehaviorState] = useState<CloseBehavior>(readStoredBehavior);
  const [isCloseChoiceOpen, setIsCloseChoiceOpen] = useState(false);
  const closeBehaviorRef = useRef(closeBehavior);

  // 同步 ref（供 requestClose 使用，避免 stale closure）
  if (closeBehaviorRef.current !== closeBehavior) {
    closeBehaviorRef.current = closeBehavior;
  }

  const setCloseBehavior = useCallback(async (next: CloseBehavior) => {
    window.localStorage.setItem("zc-close-behavior", next);
    setCloseBehaviorState(next);
  }, []);

  const closeForPlatform = useCallback(async () => {
    const win = getCurrentWindow();
    if (platform === "darwin") {
      await win.hide();
      return;
    }
    await win.close();
  }, [platform]);

  const requestClose = useCallback(() => {
    if (platform === "darwin" || platform === "win32") {
      setIsCloseChoiceOpen(false);
      void closeForPlatform();
      return;
    }

    const behavior = closeBehaviorRef.current;
    if (behavior === "ask") {
      setIsCloseChoiceOpen(true);
      return;
    }
    if (behavior === "quit") void closeForPlatform();
    if (behavior === "minimize") void getCurrentWindow().minimize();
    setIsCloseChoiceOpen(false);
  }, [closeForPlatform]);

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
        if (action === "quit") void closeForPlatform();
        if (action === "minimize") void getCurrentWindow().minimize();
      },
      [closeForPlatform, setCloseBehavior]
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
