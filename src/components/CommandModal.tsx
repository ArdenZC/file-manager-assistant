import { useEffect, useMemo, useState, type RefObject } from "react";
import { ChevronRight, File, Search, X } from "lucide-react";
import { tauriApi } from "../api/tauriApi";
import type { FileRecord } from "../types/domain";
import type { Translator, View } from "../types/ui";
import { cn, emptyState, toneClasses } from "../utils/tw";

export function CommandModal({
  inputRef,
  setView,
  setSelectedFileId,
  onClose,
  platform,
  t,
  standalone = false
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  setView: (view: View) => void;
  setSelectedFileId: (id: string) => void;
  onClose: () => void;
  platform: NodeJS.Platform | "browser";
  t: Translator;
  standalone?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<FileRecord[]>([]);
  const [queryState, setQueryState] = useState<"idle" | "pending" | "done" | "failed">("idle");
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmedSearch = search.trim();
  const showResults = trimmedSearch.length > 0 && results.length > 0;
  const locateKey = platform === "darwin" ? "⌥↵" : "Alt↵";

  useEffect(() => {
    if (!trimmedSearch) {
      setResults([]);
      setQueryState("idle");
      setActiveIndex(0);
      return;
    }

    let cancelled = false;
    setQueryState("pending");
    const timer = window.setTimeout(() => {
      tauriApi.getPagedFiles(12, 0, trimmedSearch)
        .then((page) => {
          if (cancelled) return;
          setResults(page.files);
          setQueryState("done");
          setActiveIndex(0);
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setQueryState("failed");
        });
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmedSearch]);

  const visibleResults = useMemo(() => results.slice(0, 12), [results]);

  function chooseFile(file: FileRecord) {
    setSelectedFileId(file.id);
    setView("library");
    onClose();
  }

  async function revealFile(file: FileRecord) {
    try {
      await tauriApi.revealInFolder(file.path);
    } catch (error) {
      console.error("Failed to reveal file in folder.", error);
    }
  }

  function openSortingPreview() {
    setView("preview");
    onClose();
  }

  function clearSearch() {
    setSearch("");
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }

  function getResultTone(file: FileRecord) {
    if (file.risk_level === "Sensitive") return "red";
    if (file.lifecycle === "Archive") return "purple";
    return "blue";
  }

  return (
    <div
      className={cn(
        standalone
          ? "relative z-10 flex h-full w-full items-start justify-center p-6"
          : "fixed inset-0 z-40 flex items-start justify-center bg-slate-950/25 px-6 pt-20 backdrop-blur-lg"
      )}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={cn(
          "w-full max-w-3xl overflow-hidden border border-[var(--line)] bg-[linear-gradient(135deg,var(--surface-strong),var(--surface-soft))] shadow-[var(--shadow-cmd)] backdrop-blur-3xl transition-all",
          standalone && "mt-12",
          showResults ? "rounded-3xl" : "rounded-[2rem]"
        )}
        onKeyDown={(event) => {
          if ((event.metaKey && event.key === "Backspace") || (event.ctrlKey && event.key === "Backspace")) {
            event.preventDefault();
            clearSearch();
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, visibleResults.length - 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Enter" && event.altKey && visibleResults[activeIndex]) {
            event.preventDefault();
            void revealFile(visibleResults[activeIndex]);
            return;
          }
          if (event.key === "Enter" && visibleResults[activeIndex]) {
            event.preventDefault();
            chooseFile(visibleResults[activeIndex]);
          }
          if (event.key === "Tab") {
            event.preventDefault();
            openSortingPreview();
          }
          if (event.key === "Escape") onClose();
        }}
      >
        <div className={cn("flex h-16 items-center gap-3 px-5", showResults && "border-b border-[var(--line-dark)]")}>
          <Search className="text-blue-500" size={20} strokeWidth={2.2} />
          <input
            ref={inputRef}
            value={search}
            placeholder={t("commandPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
            onClick={() => inputRef.current?.focus()}
            className="h-full min-w-0 flex-1 bg-transparent text-base text-[var(--ink)] outline-none placeholder:text-[var(--quiet)]"
          />
          {search && (
            <button className="grid h-8 w-8 place-items-center rounded-full text-[var(--muted)] transition hover:bg-white/50 hover:text-[var(--ink)] dark:hover:bg-white/10" onClick={clearSearch} aria-label={t("clearSearch")}>
              <X size={16} strokeWidth={2.5} />
            </button>
          )}
          <kbd className="rounded-md border border-[var(--line-dark)] px-2 py-1 text-[11px] text-[var(--quiet)]">ESC</kbd>
        </div>
        {showResults && (
          <div className="grid gap-0">
            <div className="px-3 py-3">
              <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--quiet)]">{t("smartMatches")}</div>
              <div className="grid gap-1">
                {visibleResults.map((file, index) => {
                  const tone = getResultTone(file);
                  const extension = file.extension ? file.extension.replace(".", "").toUpperCase() : file.file_type;
                  return (
                    <button
                      key={file.id}
                      className={cn(
                        "grid grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl px-3 py-3 text-left transition",
                        index === activeIndex ? "bg-white/60 shadow-sm dark:bg-white/10" : "hover:bg-white/30 dark:hover:bg-white/10"
                      )}
                      onClick={() => chooseFile(file)}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span className={cn("grid h-10 w-10 place-items-center rounded-xl border", toneClasses(tone))}>
                        <File size={20} strokeWidth={1.5} />
                      </span>
                      <span className="min-w-0">
                        <strong className="block truncate text-sm font-semibold"><HighlightText text={file.name} highlight={trimmedSearch} /></strong>
                        <small className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[var(--muted)]">
                          <span className="truncate">{file.directory || file.path}</span>
                          <i className="h-1 w-1 shrink-0 rounded-full bg-[var(--quiet)]" />
                          <em className={cn("shrink-0 not-italic", toneClasses(tone).split(" ").filter((item) => item.startsWith("text-")).join(" "))}>{file.purpose}</em>
                        </small>
                      </span>
                      <span className="flex items-center gap-2 text-xs text-[var(--quiet)]">
                        <em className="not-italic">{extension}</em>
                        {index === activeIndex && <ChevronRight className="text-blue-500" size={16} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-[var(--line-dark)] px-5 py-3 text-xs text-[var(--muted)]">
              <span>{t("matchesFound").replace("{count}", String(visibleResults.length))}</span>
              <div className="flex items-center gap-3">
                <span><kbd className="mr-1 rounded border border-[var(--line-dark)] px-1.5 py-0.5">↵</kbd>{t("openResult")}</span>
                <span><kbd className="mr-1 rounded border border-[var(--line-dark)] px-1.5 py-0.5">{locateKey}</kbd>{t("revealPhysical")}</span>
                <span><kbd className="mr-1 rounded border border-[var(--line-dark)] px-1.5 py-0.5">⇥</kbd>{t("sortingAdvice")}</span>
              </div>
            </div>
          </div>
        )}
        {trimmedSearch && queryState === "done" && !results.length && (
          <div className="px-4 pb-4">
            <div className={cn(emptyState, "min-h-20")}>{t("noOperations")}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function HighlightText({ text, highlight }: { text: string; highlight: string }) {
  const value = highlight.trim();
  if (!value) return <>{text}</>;
  const escaped = value.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const matcher = new RegExp(`(${escaped})`, "ig");
  return (
    <>
      {text.split(matcher).map((part, index) => (
        part.toLowerCase() === value.toLowerCase()
          ? <mark className="rounded bg-blue-400/20 px-0.5 text-blue-700 dark:text-blue-200" key={`${part}-${index}`}>{part}</mark>
          : <span key={`${part}-${index}`}>{part}</span>
      ))}
    </>
  );
}
