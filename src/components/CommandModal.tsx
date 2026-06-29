import { useEffect, useMemo, useState, type ReactNode, type RefObject } from "react";
import { ChevronRight, File, Search, X } from "lucide-react";
import { tauriApi } from "../api/tauriApi";
import type { FileRecord, LibraryScope } from "../types/domain";
import type { Translator, View } from "../types/ui";
import { cn, toneClasses } from "../utils/tw";
import { readableError } from "../utils/viewHelpers";

const keyBadge =
  "rounded-md border border-[var(--line-dark)] bg-white/32 px-1.5 py-0.5 text-[11px] font-medium text-[var(--quiet)] dark:bg-white/5";
const commandHintText = "text-[11px] leading-tight text-[var(--quiet)]";

export async function activateCommandNavigation({
  standalone,
  view,
  fileId,
  setView,
  setSelectedFileId,
  onClose,
  activateSearchResult = tauriApi.activateSearchResult
}: {
  standalone: boolean;
  view: View;
  fileId: string | null;
  setView: (view: View) => void;
  setSelectedFileId: (id: string) => void;
  onClose: () => void;
  activateSearchResult?: (view: View, fileId: string | null) => Promise<void>;
}) {
  if (standalone) {
    await activateSearchResult(view, fileId);
    return;
  }

  if (fileId) setSelectedFileId(fileId);
  setView(view);
  onClose();
}

export function CommandModal({
  inputRef,
  setView,
  setSelectedFileId,
  onClose,
  platform,
  t,
  onError,
  searchScope,
  searchScopeLabel,
  searchScopeEmptyMessage,
  standalone = false
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  setView: (view: View) => void;
  setSelectedFileId: (id: string) => void;
  onClose: () => void;
  platform: NodeJS.Platform | "browser";
  t: Translator;
  onError?: (message: string) => void;
  searchScope?: LibraryScope;
  searchScopeLabel?: string;
  searchScopeEmptyMessage?: string;
  standalone?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<FileRecord[]>([]);
  const [queryState, setQueryState] = useState<"idle" | "pending" | "done" | "failed">("idle");
  const [commandError, setCommandError] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const trimmedSearch = search.trim();
  const showResults = trimmedSearch.length > 0 && results.length > 0;
  const activeResultId = showResults ? `command-result-${activeIndex}` : undefined;
  const locateKey = platform === "darwin" ? "⌥↵" : "Alt↵";

  useEffect(() => {
    if (!trimmedSearch) {
      setResults([]);
      setQueryState("idle");
      setCommandError("");
      setActiveIndex(0);
      return;
    }

    let cancelled = false;
    setCommandError("");
    if (searchScopeEmptyMessage) {
      setResults([]);
      setQueryState("done");
      setActiveIndex(0);
      return;
    }
    setQueryState("pending");
    const timer = window.setTimeout(() => {
      tauriApi.searchFiles(trimmedSearch, 12, searchScope)
        .then((files) => {
          if (cancelled) return;
          setResults(files);
          setQueryState("done");
          setActiveIndex(0);
        })
        .catch(() => {
          if (cancelled) return;
          setResults([]);
          setQueryState("failed");
          setCommandError(t("commandSearchFailed"));
        });
    }, 50);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchScope, searchScopeEmptyMessage, t, trimmedSearch]);

  const visibleResults = useMemo(() => results.slice(0, 12), [results]);

  async function chooseFile(file: FileRecord) {
    try {
      await activateCommandNavigation({
        standalone,
        view: "library",
        fileId: file.id,
        setView,
        setSelectedFileId,
        onClose
      });
    } catch (error) {
      const message = readableError(error);
      setCommandError(message);
      onError?.(message);
    }
  }

  async function revealFile(file: FileRecord) {
    try {
      await tauriApi.revealInFolder(file.path);
    } catch (error) {
      const message = readableError(error);
      setCommandError(message);
      onError?.(message);
    }
  }

  async function openSortingPreview() {
    try {
      await activateCommandNavigation({
        standalone,
        view: "preview",
        fileId: null,
        setView,
        setSelectedFileId,
        onClose
      });
    } catch (error) {
      const message = readableError(error);
      setCommandError(message);
      onError?.(message);
    }
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
          ? "relative z-10 flex h-full w-full items-center justify-center p-5"
          : "fixed inset-0 z-40 flex items-start justify-center bg-slate-950/22 px-6 pt-20 backdrop-blur-lg"
      )}
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <div
        className={cn(
          "w-full max-w-3xl overflow-hidden border border-[var(--line)] bg-[linear-gradient(135deg,var(--surface-strong),var(--surface-soft))] shadow-[var(--shadow-cmd)] backdrop-blur-3xl transition-[border-radius,background,box-shadow]",
          standalone && "mb-8 max-w-[720px]",
          showResults ? "rounded-[1.75rem]" : "rounded-[2rem]"
        )}
        onKeyDown={(event) => {
          if ((event.metaKey && event.key === "Backspace") || (event.ctrlKey && event.key === "Backspace")) {
            event.preventDefault();
            clearSearch();
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, Math.max(0, visibleResults.length - 1)));
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
            void chooseFile(visibleResults[activeIndex]);
          }
          if (event.key === "Tab") {
            event.preventDefault();
            void openSortingPreview();
          }
          if (event.key === "Escape") onClose();
        }}
      >
        <div className={cn("flex h-[60px] min-h-[60px] items-center gap-3 px-5", showResults && "border-b border-[var(--line-dark)]")}>
          <Search className="text-blue-500" size={20} strokeWidth={2.2} />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded={showResults}
            aria-controls="command-results"
            aria-activedescendant={activeResultId}
            value={search}
            placeholder={t("commandPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
            onClick={() => inputRef.current?.focus()}
            className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-[var(--ink)] outline-none placeholder:text-[var(--quiet)]"
          />
          {search && (
            <button className="grid h-8 w-8 place-items-center rounded-full text-[var(--muted)] transition-[background,color] hover:bg-white/46 hover:text-[var(--ink)] dark:hover:bg-white/10" onClick={clearSearch} aria-label={t("clearSearch")}>
              <X size={16} strokeWidth={2.5} />
            </button>
          )}
          <kbd className={cn(keyBadge, "px-2 py-1")}>ESC</kbd>
        </div>
        {searchScopeLabel && <div className={cn(commandHintText, "px-5 pb-2 pt-1.5")}>{searchScopeLabel}</div>}
        {showResults && (
          <div className="grid gap-0">
            <div className="px-3 py-3">
              <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--quiet)]">{t("smartMatches")}</div>
              <div id="command-results" role="listbox" className="grid gap-1">
                {visibleResults.map((file, index) => {
                  const tone = getResultTone(file);
                  const extension = file.extension ? file.extension.replace(".", "").toUpperCase() : file.file_type;
                  return (
                    <button
                      key={file.id}
                      id={`command-result-${index}`}
                      role="option"
                      aria-selected={index === activeIndex}
                      className={cn(
                        "grid min-h-[66px] grid-cols-[42px_minmax(0,1fr)_auto] items-center gap-3 rounded-2xl border px-3 py-3 text-left transition-[background,border-color,box-shadow,color]",
                        index === activeIndex
                          ? "border-blue-400/30 bg-white/62 shadow-[inset_0_1px_0_rgba(255,255,255,0.60),0_0_0_3px_rgba(59,130,246,0.08)] dark:bg-white/10"
                          : "border-transparent hover:bg-white/30 dark:hover:bg-white/10"
                      )}
                      onClick={() => void chooseFile(file)}
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
            <div className="flex items-center justify-between gap-3 border-t border-[var(--line-dark)] px-5 py-3 text-xs text-[var(--muted)]">
              <span>{t("matchesFound").replace("{count}", String(visibleResults.length))}</span>
              <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 gap-y-1">
                <ShortcutHint badge="↵" label={t("openResult")} />
                <ShortcutHint badge={locateKey} label={t("revealPhysical")} />
                <ShortcutHint badge="⇥" label={t("sortingAdvice")} />
              </div>
            </div>
          </div>
        )}
        {trimmedSearch && queryState === "pending" && (
          <div className="px-4 pb-4">
            <CommandEmptyState>{t("commandSearching")}</CommandEmptyState>
          </div>
        )}
        {trimmedSearch && queryState === "failed" && (
          <div className="px-4 pb-4">
            <CommandEmptyState tone="error">{commandError || t("commandSearchFailed")}</CommandEmptyState>
          </div>
        )}
        {trimmedSearch && queryState === "done" && !results.length && (
          <div className="px-4 pb-4">
            <CommandEmptyState>{searchScopeEmptyMessage || t("commandNoResults")}</CommandEmptyState>
          </div>
        )}
      </div>
    </div>
  );
}

function ShortcutHint({ badge, label }: { badge: string; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1 whitespace-nowrap">
      <kbd className={keyBadge}>{badge}</kbd>
      <span className="hidden max-w-24 truncate sm:inline">{label}</span>
    </span>
  );
}

function CommandEmptyState({
  children,
  tone = "neutral"
}: {
  children: ReactNode;
  tone?: "neutral" | "error";
}) {
  return (
    <div
      className={cn(
        "grid min-h-16 place-items-center rounded-2xl border border-dashed px-4 py-3 text-center text-sm",
        tone === "error"
          ? "border-red-400/35 bg-red-500/8 text-red-700 dark:text-red-200"
          : "border-[var(--line-dark)] bg-white/16 text-[var(--muted)] dark:bg-white/5"
      )}
    >
      {children}
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
