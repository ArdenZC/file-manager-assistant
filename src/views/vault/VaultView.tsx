import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { Plus, Search } from "lucide-react";
import { tauriApi } from "../../api/tauriApi";
import { useChromeContext } from "../../contexts/AppContexts";
import { useDebounce } from "../../hooks/useDebounce";
import { useAppStore } from "../../store/useAppStore";
import { LIBRARY_PAGE_SIZE, useFileLibraryStore } from "../../store/useFileLibraryStore";
import type { FileRecord } from "../../types/domain";
import type { Translator } from "../../types/ui";
import { shouldVirtualizeList } from "../../utils/virtualization";
import { cn, glassButton, inputSurface, statusToast, virtualList, virtualSpacer } from "../../utils/tw";
import { listMotion, mutedText, pageSurface, segmentButton } from "../shared/ui";
import { AssetCard } from "./AssetCard";

const ASSET_GRID_ROW_HEIGHT = 234;

export function VaultView() {
  const { onError, t } = useChromeContext();
  const searchQuery = useAppStore((state) => state.searchQuery);
  const setSearchQuery = useAppStore((state) => state.setSearchQuery);
  const debouncedSearchQuery = useDebounce(searchQuery, 300);
  const page = useFileLibraryStore((state) => state.libraryPage);
  const selectedFileId = useFileLibraryStore((state) => state.selectedFileId);
  const selectedFile = page.files.find((file) => file.id === selectedFileId) ?? page.files[0];
  const setPage = useFileLibraryStore((state) => state.setLibraryPage);
  const setSelectedFileId = useFileLibraryStore((state) => state.setSelectedFileId);
  const loadStats = useFileLibraryStore((state) => state.loadStats);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const hasMore = page.files.length < page.total;

  const loadPage = useCallback(async (offset: number, append: boolean) => {
    const requestId = ++requestIdRef.current;
    setIsLoading(true);
    setError("");
    try {
      const next = await tauriApi.getPagedFiles(LIBRARY_PAGE_SIZE, offset, debouncedSearchQuery);
      if (requestId !== requestIdRef.current) return;
      setPage((current) => append
        ? { ...next, files: [...current.files, ...next.files], offset: current.offset }
        : next
      );
      if (!append && next.files[0]) setSelectedFileId(next.files[0].id);
      await loadStats();
    } catch (caught) {
      if (requestId === requestIdRef.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (requestId === requestIdRef.current) setIsLoading(false);
    }
  }, [debouncedSearchQuery, loadStats, setPage, setSelectedFileId]);

  useEffect(() => {
    void loadPage(0, false);
  }, [loadPage]);

  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !hasMore || isLoading) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        void loadPage(page.files.length, true);
      }
    }, { rootMargin: "320px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadPage, page.files.length]);

  const filters = [
    { key: "", label: t("libraryAllFiles"), description: t("libraryAllFilesDesc") },
    { key: "active", label: t("libraryActiveFiles"), description: t("libraryActiveFilesDesc") },
    { key: "archive", label: t("libraryArchiveFiles"), description: t("libraryArchiveFilesDesc") },
    { key: "review", label: t("libraryReviewFiles"), description: t("libraryReviewFilesDesc") }
  ];

  return (
    <div className={cn(pageSurface, "space-y-4")}>
      <div className="flex flex-wrap gap-2">
        {filters.map((filter) => (
          <button
            key={filter.label}
            className={segmentButton(searchQuery === filter.key)}
            onClick={() => setSearchQuery(filter.key)}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {filters.map((filter) => (
          <span
            className={cn(
              "rounded-2xl border border-[var(--line)] bg-white/25 p-3 text-sm text-[var(--muted)] dark:bg-white/5",
              searchQuery === filter.key && "border-blue-400/50 bg-blue-500/10 text-[var(--ink)]"
            )}
            key={`${filter.key}-description`}
          >
            <strong className="mb-1 block text-[var(--ink)]">{filter.label}</strong>
            {filter.description}
          </span>
        ))}
      </div>
      <p className={mutedText}>{t("libraryIntro")}</p>
      <label className={cn(inputSurface, "flex items-center gap-2 px-3")}>
        <Search size={16} />
        <input
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t("librarySearchPlaceholder")}
          className="min-w-0 flex-1 bg-transparent outline-none"
        />
      </label>
      <div className="flex items-center justify-between gap-3 text-sm text-[var(--muted)]">
        <span>{t("libraryShowing").replace("{visible}", String(page.files.length)).replace("{total}", String(page.total))}</span>
        {isLoading && <em className="not-italic">{t("loading")}</em>}
      </div>
      {error && <div className={cn(statusToast, "mt-0")}>{error}</div>}
      <VirtualAssetGrid
        files={page.files}
        onError={onError}
        selectedFileId={selectedFile?.id}
        setSelectedFileId={setSelectedFileId}
        t={t}
      />
      <div ref={sentinelRef} className="h-1" />
      {hasMore && (
        <button className={cn(glassButton, "mx-auto flex")} onClick={() => void loadPage(page.files.length, true)} disabled={isLoading}>
          <Plus size={16} />
          {t("loadMoreFiles").replace("{count}", String(Math.min(page.limit, page.total - page.files.length)))}
        </button>
      )}
    </div>
  );
}

function VirtualAssetGrid({
  files,
  onError,
  selectedFileId,
  setSelectedFileId,
  t
}: {
  files: FileRecord[];
  onError: (message: string) => void;
  selectedFileId?: string;
  setSelectedFileId: (id: string) => void;
  t: Translator;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(4);
  const shouldVirtualize = shouldVirtualizeList(files.length);
  const rowCount = Math.ceil(files.length / columns);
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ASSET_GRID_ROW_HEIGHT,
    overscan: 4
  });

  useEffect(() => {
    const node = parentRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      const nextColumns = Math.max(1, Math.min(4, Math.floor(width / 220)));
      setColumns(nextColumns || 1);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  if (!shouldVirtualize) {
    return (
      <motion.section className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3" variants={listMotion} initial="hidden" animate="show">
        {files.map((file) => (
          <AssetCard
            file={file}
            isSelected={selectedFileId === file.id}
            key={file.id}
            onError={onError}
            setSelectedFileId={setSelectedFileId}
            t={t}
          />
        ))}
      </motion.section>
    );
  }

  return (
    <section ref={parentRef} className={cn("h-[calc(100vh-330px)] min-h-80", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const start = virtualRow.index * columns;
          const rowFiles = files.slice(start, start + columns);
          return (
            <div
              className="absolute left-0 top-0 grid w-full gap-3"
              key={virtualRow.key}
              style={{
                gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              {rowFiles.map((file) => (
                <AssetCard
                  file={file}
                  isSelected={selectedFileId === file.id}
                  key={file.id}
                  onError={onError}
                  setSelectedFileId={setSelectedFileId}
                  t={t}
                />
              ))}
            </div>
          );
        })}
      </div>
    </section>
  );
}

