import { useEffect, useMemo, useState, type RefObject } from "react";
import { ChevronRight, File, Search, X } from "lucide-react";
import type { FileRecord, SearchResult } from "../types/domain";
import type { Translator, View } from "../types/ui";

export function CommandModal({
  inputRef,
  files,
  setView,
  setSelectedFileId,
  onClose,
  platform,
  t,
  standalone = false
}: {
  inputRef: RefObject<HTMLInputElement | null>;
  files: FileRecord[];
  setView: (view: View) => void;
  setSelectedFileId: (id: string) => void;
  onClose: () => void;
  platform: NodeJS.Platform | "browser";
  t: Translator;
  standalone?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [nativeResults, setNativeResults] = useState<SearchResult[]>([]);
  const [nativeQueryState, setNativeQueryState] = useState<{
    query: string;
    status: "idle" | "pending" | "done" | "failed";
  }>({ query: "", status: "idle" });
  const [activeIndex, setActiveIndex] = useState(0);
  const fileManager = window.fileManager;
  const hasNativeApi = typeof fileManager !== "undefined";
  void setView;
  void setSelectedFileId;
  const trimmedSearch = search.trim();
  const nativeFinishedForQuery =
    nativeQueryState.query === trimmedSearch &&
    (nativeQueryState.status === "done" || nativeQueryState.status === "failed");
  const currentNativeResults =
    nativeQueryState.query === trimmedSearch && nativeQueryState.status === "done" ? nativeResults : [];
  const shouldUseSnapshotFallback =
    trimmedSearch.length > 0 &&
    (!hasNativeApi || (nativeFinishedForQuery && (nativeQueryState.status === "failed" || nativeResults.length === 0)));
  const fallbackResults = useMemo(
    () => (shouldUseSnapshotFallback ? findSearchSnapshotMatches(files, trimmedSearch, 12) : []),
    [files, shouldUseSnapshotFallback, trimmedSearch]
  );
  const results = useMemo(
    () => (trimmedSearch ? mergeSearchResults(hasNativeApi ? currentNativeResults : [], fallbackResults, 12) : []),
    [currentNativeResults, fallbackResults, hasNativeApi, trimmedSearch]
  );
  const showResults = trimmedSearch.length > 0 && results.length > 0;
  const locateKey = platform === "darwin" ? "⌥↵" : "Alt↵";

  useEffect(() => {
    if (!fileManager) return;
    if (!trimmedSearch) {
      setNativeResults([]);
      setNativeQueryState({ query: "", status: "idle" });
      setActiveIndex(0);
      return;
    }
    setNativeQueryState({ query: trimmedSearch, status: "pending" });
    let cancelled = false;
    const timer = window.setTimeout(() => {
      fileManager.searchQuery({ query: trimmedSearch, limit: 12 })
        .then((next) => {
          if (cancelled) return;
          setNativeResults(next);
          setNativeQueryState({ query: trimmedSearch, status: "done" });
          setActiveIndex(0);
        })
        .catch(() => {
          if (cancelled) return;
          setNativeResults([]);
          setNativeQueryState({ query: trimmedSearch, status: "failed" });
        });
    }, 40);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [fileManager, trimmedSearch]);

  async function openFile(file: FileRecord) {
    if (fileManager) {
      await fileManager.openSearchResult(file.id);
    }
    onClose();
  }

  async function revealFile(file: FileRecord) {
    if (fileManager) {
      await fileManager.revealSearchResult(file.id);
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
    <div className={`command-backdrop ${standalone ? "standalone" : ""}`} onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={`command-modal ${standalone ? "standalone-modal" : ""} ${showResults ? "rounded-24" : "rounded-36"}`}
        onKeyDown={(event) => {
          if ((event.metaKey && event.key === "Backspace") || (event.ctrlKey && event.key === "Backspace")) {
            event.preventDefault();
            clearSearch();
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, results.length - 1));
          }
          if (event.key === "ArrowUp") {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          }
          if (event.key === "Enter" && results[activeIndex]) {
            event.preventDefault();
            if (event.altKey) void revealFile(results[activeIndex].file);
            else void openFile(results[activeIndex].file);
          }
          if (event.key === "Escape") onClose();
        }}
      >
        <div className={`command-search-head ${showResults ? "has-results" : ""}`}>
          <Search className="command-search-icon" size={20} strokeWidth={2.2} />
          <input
            ref={inputRef}
            value={search}
            placeholder={t("commandPlaceholder")}
            onChange={(event) => setSearch(event.target.value)}
            onClick={() => inputRef.current?.focus()}
          />
          {search && (
            <button className="command-clear-button" onClick={clearSearch} aria-label={t("clearSearch")}>
              <X size={16} strokeWidth={2.5} />
            </button>
          )}
          <kbd className="command-esc-key">ESC</kbd>
        </div>
        {showResults && (
          <div className="command-results-panel">
            <div className="command-results">
              <div className="command-section-label">{t("smartMatches")}</div>
              <div className="command-result-stack">
                {results.map(({ file }, index) => {
                  const tone = getResultTone(file);
                  const extension = file.extension ? file.extension.replace(".", "").toUpperCase() : file.file_type;
                  return (
                    <button
                      key={file.id}
                      className={`result-item-card ${index === activeIndex ? "active-row" : ""}`}
                      onClick={() => openFile(file)}
                      onMouseEnter={() => setActiveIndex(index)}
                    >
                      <span className={`result-main-icon ${tone}`}>
                        <File size={20} strokeWidth={1.5} />
                      </span>
                      <span className="result-copy">
                        <strong><HighlightText text={file.name} highlight={trimmedSearch} /></strong>
                        <small>
                          <span>{file.directory || file.path}</span>
                          <i />
                          <em className={tone}>{file.purpose}</em>
                        </small>
                      </span>
                      <span className="result-trailing">
                        <em>{extension}</em>
                        {index === activeIndex && <ChevronRight className="command-row-chevron" size={16} />}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="command-action-bar">
              <span>{t("matchesFound").replace("{count}", String(results.length))}</span>
              <div>
                <span><kbd>↵</kbd>{t("openResult")}</span>
                <span><kbd>{locateKey}</kbd>{t("revealPhysical")}</span>
                <span><kbd>⇥</kbd>{t("sortingAdvice")}</span>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function findSearchSnapshotMatches(files: FileRecord[], query: string, limit: number) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const results: SearchResult[] = [];
  for (const file of files) {
    const haystack = [
      file.name,
      file.path,
      file.directory,
      file.extension,
      file.file_type,
      file.purpose,
      file.lifecycle,
      file.context
    ].join(" ").toLowerCase();
    if (!terms.every((term) => haystack.includes(term))) continue;
    results.push({ file, score: 10, matched_text: file.name });
    if (results.length >= limit) break;
  }
  return results;
}

function mergeSearchResults(primary: SearchResult[], fallback: SearchResult[], limit: number) {
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const result of [...primary, ...fallback]) {
    if (seen.has(result.file.id)) continue;
    seen.add(result.file.id);
    merged.push(result);
    if (merged.length >= limit) break;
  }
  return merged;
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
          ? <mark className="highlight-mark" key={`${part}-${index}`}>{part}</mark>
          : <span key={`${part}-${index}`}>{part}</span>
      ))}
    </>
  );
}
