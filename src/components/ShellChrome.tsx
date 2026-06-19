import { useState } from "react";
import { Languages, Monitor, Moon, Sun } from "lucide-react";
import type { Language } from "../i18n";
import type { ThemeMode, Translator } from "../types/ui";
import { cn, glassButton, glassButtonPrimary, glassPanel } from "../utils/tw";

export function ZenMark() {
  return (
    <div className="relative h-9 w-9 shrink-0" aria-hidden="true">
      <span className="absolute inset-0 rounded-2xl bg-blue-500 shadow-lg shadow-blue-500/20" />
      <span className="absolute inset-1 rounded-xl border border-white/70 bg-white/40 backdrop-blur-md dark:border-white/20 dark:bg-white/10" />
    </div>
  );
}

export function AmbientMesh() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div className="absolute -left-32 -top-28 h-80 w-80 rounded-full bg-blue-400/20 blur-3xl" />
      <div className="absolute right-0 top-1/4 h-96 w-96 rounded-full bg-emerald-300/10 blur-3xl" />
      <div className="absolute bottom-[-18rem] left-1/3 h-[32rem] w-[32rem] rounded-full bg-violet-400/10 blur-3xl" />
    </div>
  );
}

export function TitlebarTools({
  language,
  theme,
  effectiveTheme,
  setLanguage,
  setTheme
}: {
  language: Language;
  theme: ThemeMode;
  effectiveTheme: Exclude<ThemeMode, "system">;
  setLanguage: (language: Language) => void;
  setTheme: (theme: ThemeMode) => void;
}) {
  return (
    <div className="flex items-center gap-2 [-webkit-app-region:no-drag]">
      <button
        className="grid h-8 w-8 place-items-center rounded-full border border-[var(--line-dark)] bg-white/40 text-[var(--muted)] transition hover:bg-white/70 hover:text-[var(--ink)] dark:bg-white/5 dark:hover:bg-white/10"
        onClick={() => setTheme(effectiveTheme === "dark" ? "light" : "dark")}
      >
        {theme === "system" ? <Monitor size={17} /> : effectiveTheme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
      <button
        className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--line-dark)] bg-white/40 px-3 text-xs font-medium text-[var(--muted)] transition hover:bg-white/70 hover:text-[var(--ink)] dark:bg-white/5 dark:hover:bg-white/10"
        onClick={() => setLanguage(language === "zh" ? "en" : "zh")}
      >
        <Languages size={16} />
        <span>{language === "zh" ? "EN" : "中文"}</span>
      </button>
    </div>
  );
}

export function CloseChoiceDialog({
  t,
  onCancel,
  onChoose
}: {
  t: Translator;
  onCancel: () => void;
  onChoose: (action: "minimize" | "quit", remember: boolean) => Promise<void>;
}) {
  const [remember, setRemember] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState<"minimize" | "quit" | null>(null);

  async function choose(action: "minimize" | "quit") {
    setIsSubmitting(action);
    await onChoose(action, remember);
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/30 p-6 backdrop-blur-xl" role="dialog" aria-modal="true">
      <section className={cn(glassPanel, "grid w-full max-w-md gap-5 p-6")}>
        <div className="mx-auto">
          <ZenMark />
        </div>
        <div className="text-center">
          <h2 className="text-xl font-semibold">{t("closeChoiceTitle")}</h2>
          <p className="mt-2 text-sm text-[var(--muted)]">{t("closeChoiceDesc")}</p>
        </div>
        <label className="flex items-center justify-center gap-2 text-sm text-[var(--muted)]">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>{t("doNotAskAgain")}</span>
        </label>
        <div className="grid grid-cols-3 gap-2">
          <button className={glassButton} onClick={onCancel} disabled={isSubmitting !== null}>
            {t("cancel")}
          </button>
          <button className={glassButton} onClick={() => void choose("quit")} disabled={isSubmitting !== null}>
            {t("quitApp")}
          </button>
          <button className={glassButtonPrimary} onClick={() => void choose("minimize")} disabled={isSubmitting !== null}>
            {t("minimizeToTray")}
          </button>
        </div>
      </section>
    </div>
  );
}
