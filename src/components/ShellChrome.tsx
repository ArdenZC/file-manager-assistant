import { useState } from "react";
import { Languages, Monitor, Moon, Sun } from "lucide-react";
import type { Language } from "../i18n";
import type { ThemeMode, Translator } from "../types/ui";

export function ZenMark() {
  return (
    <div className="zen-mark" aria-hidden="true">
      <span className="zen-orb" />
      <span className="zen-glass" />
    </div>
  );
}

export function AmbientMesh() {
  return (
    <div className="ambient-mesh" aria-hidden="true">
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
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
    <div className="titlebar-tools">
      <button className="round-tool" onClick={() => setTheme(effectiveTheme === "dark" ? "light" : "dark")}>
        {theme === "system" ? <Monitor size={17} /> : effectiveTheme === "dark" ? <Moon size={17} /> : <Sun size={17} />}
      </button>
      <button className="lang-toggle" onClick={() => setLanguage(language === "zh" ? "en" : "zh")}>
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
    <div className="choice-backdrop" role="dialog" aria-modal="true">
      <section className="choice-dialog glass-panel">
        <div className="choice-icon">
          <ZenMark />
        </div>
        <div>
          <h2>{t("closeChoiceTitle")}</h2>
          <p>{t("closeChoiceDesc")}</p>
        </div>
        <label className="remember-choice">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>{t("doNotAskAgain")}</span>
        </label>
        <div className="choice-actions">
          <button className="glass-button" onClick={onCancel} disabled={isSubmitting !== null}>
            {t("cancel")}
          </button>
          <button className="glass-button" onClick={() => void choose("quit")} disabled={isSubmitting !== null}>
            {t("quitApp")}
          </button>
          <button className="glass-button primary" onClick={() => void choose("minimize")} disabled={isSubmitting !== null}>
            {t("minimizeToTray")}
          </button>
        </div>
      </section>
    </div>
  );
}
