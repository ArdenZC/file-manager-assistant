import { create } from "zustand";
import type { Language } from "../i18n";
import { demoSnapshot } from "../mocks/demoData";
import type { AppSnapshot } from "../types/domain";
import type { ThemeMode, View } from "../types/ui";
import { preferredLanguage, preferredTheme } from "../utils/viewHelpers";

type SnapshotUpdate = AppSnapshot | ((current: AppSnapshot) => AppSnapshot);

interface AppStore {
  language: Language;
  theme: ThemeMode;
  view: View;
  snapshot: AppSnapshot;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeMode) => void;
  setView: (view: View) => void;
  setSnapshot: (snapshot: SnapshotUpdate) => void;
}

export const useAppStore = create<AppStore>((set) => ({
  language: preferredLanguage(),
  theme: preferredTheme(),
  view: "scanner",
  snapshot: demoSnapshot,
  setLanguage: (language) => {
    window.localStorage.setItem("zc-language", language);
    set({ language });
  },
  setTheme: (theme) => {
    window.localStorage.setItem("zc-theme", theme);
    set({ theme });
  },
  setView: (view) => set({ view }),
  setSnapshot: (snapshot) => set((state) => ({
    snapshot: typeof snapshot === "function" ? snapshot(state.snapshot) : snapshot
  }))
}));
