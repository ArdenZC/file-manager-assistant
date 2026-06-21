import { useEffect, useMemo, useState, type ReactNode } from "react";
import { tauriApi } from "../api/tauriApi";
import { makeTranslator } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { readableError } from "../utils/viewHelpers";

export function DatabaseBootstrapper({ children }: { children: ReactNode }) {
  const language = useAppStore((state) => state.language);
  const showError = useAppStore((state) => state.showError);
  const t = useMemo(() => makeTranslator(language), [language]);
  const [databaseError, setDatabaseError] = useState("");
  const [isDatabaseReady, setIsDatabaseReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function initializeDatabase() {
      try {
        await tauriApi.initDatabase();
        if (cancelled) return;
        setDatabaseError("");
        setIsDatabaseReady(true);
      } catch (error) {
        if (cancelled) return;
        const message = `${t("databaseUnavailable")}：${readableError(error)}`;
        setIsDatabaseReady(false);
        setDatabaseError(message);
        showError(message);
      }
    }

    void initializeDatabase();

    return () => {
      cancelled = true;
    };
  }, [showError, t]);

  if (databaseError) {
    return <DatabaseUnavailableState title={t("databaseUnavailable")} message={databaseError} />;
  }

  if (!isDatabaseReady) return null;

  return <>{children}</>;
}

function DatabaseUnavailableState({ title, message }: { title: string; message: string }) {
  return (
    <main className="grid h-screen min-h-[520px] place-items-center bg-[var(--bg)] px-6 text-[var(--ink)]">
      <section className="w-full max-w-lg rounded-2xl border border-[var(--line)] bg-[var(--surface)] p-6 text-center shadow-[var(--shadow)] backdrop-blur-3xl">
        <h1 className="text-xl font-semibold">{title}</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">{message}</p>
      </section>
    </main>
  );
}
