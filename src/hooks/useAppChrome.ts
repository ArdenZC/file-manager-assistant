import { useEffect, useRef, useState } from "react";
import type { Language } from "../i18n";
import type { ThemeMode } from "../types/ui";
import {
  detectBrowserPlatform,
  preferredLanguage,
  preferredTheme,
  prefersDarkScheme
} from "../utils/viewHelpers";

const IS_SEARCH_MODE = new URLSearchParams(window.location.search).get("mode") === "search";

interface UseAppChromeOptions {
  theme: ThemeMode;
  setTheme: (theme: ThemeMode) => void;
  setLanguage: (language: Language) => void;
}

export function useAppChrome({ theme, setTheme, setLanguage }: UseAppChromeOptions) {
  const [systemDark, setSystemDark] = useState(() => prefersDarkScheme());
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const commandInputRef = useRef<HTMLInputElement | null>(null);
  const platform = detectBrowserPlatform();
  const isWindows = platform === "win32";
  const effectiveTheme: Exclude<ThemeMode, "system"> = theme === "system" ? (systemDark ? "dark" : "light") : theme;
  const hotkeyLabel = platform === "darwin" ? "⌘ K" : "Ctrl K";

  useEffect(() => {
    document.documentElement.classList.toggle("search-window-root", IS_SEARCH_MODE);
    document.body.classList.toggle("search-window-root", IS_SEARCH_MODE);
    return () => {
      document.documentElement.classList.remove("search-window-root");
      document.body.classList.remove("search-window-root");
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) return;
    const handleChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    setSystemDark(mediaQuery.matches);
    mediaQuery.addEventListener("change", handleChange);
    return () => mediaQuery.removeEventListener("change", handleChange);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", effectiveTheme === "dark");
    window.localStorage.setItem("zc-theme", theme);
  }, [effectiveTheme, theme]);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key === "zc-theme") setTheme(preferredTheme());
      if (!event.key || event.key === "zc-language" || event.key === "fma-language") {
        setLanguage(preferredLanguage());
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [setLanguage, setTheme]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandOpen(true);
      }
      if (event.key === "Escape") setIsCommandOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useEffect(() => {
    if (isCommandOpen) window.setTimeout(() => commandInputRef.current?.focus(), 40);
  }, [isCommandOpen]);

  useEffect(() => {
    if (IS_SEARCH_MODE) {
      setTheme(preferredTheme());
      setLanguage(preferredLanguage());
      setIsCommandOpen(true);
    }
  }, [setLanguage, setTheme]);

  return {
    commandInputRef,
    isCommandOpen,
    setIsCommandOpen,
    platform,
    isWindows,
    effectiveTheme,
    hotkeyLabel,
    isSearchMode: IS_SEARCH_MODE
  };
}
