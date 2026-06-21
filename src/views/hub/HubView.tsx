import { useMemo, useRef, useState, type CSSProperties } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { motion } from "motion/react";
import { Check, File, FolderOpen } from "lucide-react";
import {
  useChromeContext,
  useRulesContext
} from "../../contexts/AppContexts";
import { useFileLibraryStore } from "../../store/useFileLibraryStore";
import { useOperationQueueStore } from "../../store/useOperationQueueStore";
import type { FileRecord } from "../../types/domain";
import type { Translator, View } from "../../types/ui";
import { formatBytes } from "../../utils/format";
import { shouldVirtualizeList } from "../../utils/virtualization";
import { cn, emptyState, glassButtonPrimary, toneClasses, virtualList, virtualRow as virtualRowClass, virtualSpacer } from "../../utils/tw";
import { revealFileFromCard } from "../shared/cardActions";
import { compactRowSurface, itemMotion, listMotion, mutedText, panelSurface, rowSurface } from "../shared/ui";

const HUB_FILE_ROW_HEIGHT = 82;
const BUCKET_FILE_ROW_HEIGHT = 48;
const HUB_BUCKET_KEYS = ["CoreAssets", "QuietArchive", "CleanupLane", "PrivacyVault"] as const;

export type HubBucketKey = typeof HUB_BUCKET_KEYS[number];
export type HubBucketGroups = Record<HubBucketKey, FileRecord[]>;

function createEmptyHubBucketGroups(): HubBucketGroups {
  return {
    CoreAssets: [],
    QuietArchive: [],
    CleanupLane: [],
    PrivacyVault: []
  };
}

export function getHubBucketKey(file: FileRecord): HubBucketKey {
  if (file.risk_level === "Sensitive") return "PrivacyVault";
  if (file.lifecycle === "Archive") return "QuietArchive";
  if (file.suggested_action === "DeleteCandidate" || file.suggested_action === "Review") return "CleanupLane";
  return "CoreAssets";
}

export function groupFilesByHubBucket(files: readonly FileRecord[]): HubBucketGroups {
  return files.reduce((groups, file) => {
    groups[getHubBucketKey(file)].push(file);
    return groups;
  }, createEmptyHubBucketGroups());
}

export function HubView() {
  const { t, setView, onError } = useChromeContext();
  const files = useFileLibraryStore((state) => state.libraryPage.files);
  const { rules } = useRulesContext();
  const runDispatch = useOperationQueueStore((state) => state.runDispatch);
  const [isDispatching, setIsDispatching] = useState(false);
  const activeRuleCount = useMemo(() => rules.filter((rule) => rule.enabled).length, [rules]);
  const sortedFiles = useMemo(() => files.filter(isRuleClassified), [files]);
  const pendingFiles = useMemo(() => files.filter((file) => !isRuleClassified(file)), [files]);
  const buckets = useMemo(() => [
    { key: "CoreAssets" as const, label: t("coreAssets"), description: t("coreAssetsDesc"), tone: "blue" },
    { key: "QuietArchive" as const, label: t("archiveBox"), description: t("archiveBoxDesc"), tone: "purple" },
    { key: "CleanupLane" as const, label: t("cleanupLane"), description: t("cleanupLaneDesc"), tone: "slate" },
    { key: "PrivacyVault" as const, label: t("privacyVault"), description: t("privacyVaultDesc"), tone: "red" }
  ] satisfies Array<{ key: HubBucketKey; label: string; description: string; tone: string }>, [t]);
  const bucketedFiles = useMemo(() => groupFilesByHubBucket(sortedFiles), [sortedFiles]);

  async function dispatchFiles() {
    if (isDispatching || !files.length) return;
    setIsDispatching(true);
    try {
      await runDispatch();
      setIsDispatching(false);
      setView("preview");
    } catch {
      setIsDispatching(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-[minmax(300px,0.8fr)_minmax(0,1.4fr)] gap-4 overflow-hidden">
      <section className={cn(panelSurface, "flex flex-col gap-4 overflow-hidden")}>
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-lg font-semibold">{t("inboxStack")}</h2>
          <span className={mutedText}>{pendingFiles.length} {t("items")}</span>
        </div>
        <VirtualFileCardList files={pendingFiles} onError={onError} t={t} />
        <motion.button
          whileTap={{ scale: 0.985 }}
          className={cn(glassButtonPrimary, "w-full")}
          onClick={dispatchFiles}
          disabled={isDispatching || !files.length}
          title={`${activeRuleCount} active rules`}
        >
          {isDispatching ? t("dispatching") : t("runDispatch")}
        </motion.button>
      </section>

      <motion.section className="grid min-h-0 grid-cols-2 gap-4 overflow-auto pr-1" variants={listMotion} initial="hidden" animate="show">
        {buckets.map((bucket) => {
          const bucketFiles = bucketedFiles[bucket.key];
          return (
            <motion.div
              className={cn(panelSurface, "flex min-h-[240px] flex-col gap-3", bucketFiles.length > 0 && "ring-1 ring-blue-400/20")}
              key={bucket.key}
              variants={itemMotion}
              layout
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-base font-semibold">{bucket.label}</h3>
                  <small className={mutedText}>{bucket.description}</small>
                </div>
                <span className={cn("rounded-full border px-2 py-1 text-xs font-semibold", toneClasses(bucket.tone))}>{bucketFiles.length}</span>
              </div>
              <VirtualBucketFileList files={bucketFiles} setView={setView} waitingLabel={t("waitingFlow")} />
            </motion.div>
          );
        })}
      </motion.section>
    </div>
  );
}

function VirtualFileCardList({
  files,
  onError,
  t
}: {
  files: FileRecord[];
  onError: (message: string) => void;
  t: Translator;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = shouldVirtualizeList(files.length);
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => HUB_FILE_ROW_HEIGHT,
    overscan: 8
  });

  if (!files.length) {
    return (
      <div className="min-h-0 flex-1">
        <div className={cn(emptyState, "h-full")}>
          <Check size={24} />
          <span>{t("dispatchClear")}</span>
        </div>
      </div>
    );
  }

  if (!shouldVirtualize) {
    return (
      <motion.div className="grid min-h-0 flex-1 gap-3 overflow-auto pr-1" variants={listMotion} initial="hidden" animate="show">
        {files.map((file, index) => (
          <FileCard key={file.id} file={file} index={index} onError={onError} t={t} compact />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className={cn("min-h-0 flex-1", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index];
          return (
            <div
              className={virtualRowClass}
              key={file.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <FileCard file={file} index={virtualRow.index} onError={onError} t={t} compact disableAnimation />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function VirtualBucketFileList({
  files,
  setView,
  waitingLabel
}: {
  files: FileRecord[];
  setView: (view: View) => void;
  waitingLabel: string;
}) {
  const parentRef = useRef<HTMLDivElement | null>(null);
  const shouldVirtualize = shouldVirtualizeList(files.length);
  const rowVirtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => BUCKET_FILE_ROW_HEIGHT,
    overscan: 8
  });

  if (!files.length) {
    return (
      <div className={cn(emptyState, "min-h-32")}>
        <span>{waitingLabel}</span>
      </div>
    );
  }

  if (!shouldVirtualize) {
    return (
      <motion.div className="grid gap-2" variants={listMotion} initial="hidden" animate="show">
        {files.map((file) => (
          <BucketFileButton file={file} key={file.id} setView={setView} />
        ))}
      </motion.div>
    );
  }

  return (
    <div ref={parentRef} className={cn("min-h-32", virtualList)}>
      <div className={virtualSpacer} style={{ height: `${rowVirtualizer.getTotalSize()}px` }}>
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const file = files[virtualRow.index];
          return (
            <div
              className={virtualRowClass}
              key={file.id}
              style={{
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`
              }}
            >
              <BucketFileButton file={file} setView={setView} disableAnimation />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BucketFileButton({
  file,
  setView,
  disableAnimation = false
}: {
  file: FileRecord;
  setView: (view: View) => void;
  disableAnimation?: boolean;
}) {
  return (
    <motion.button
      className={cn(compactRowSurface, "flex w-full items-center gap-2 overflow-hidden text-sm hover:bg-white/50 dark:hover:bg-white/10")}
      layout={!disableAnimation}
      variants={disableAnimation ? undefined : itemMotion}
      initial={disableAnimation ? false : undefined}
      animate={disableAnimation ? false : undefined}
      onClick={() => setView("preview")}
    >
      <File size={15} />
      <span className="truncate">{file.name}</span>
    </motion.button>
  );
}

function isRuleClassified(file: FileRecord): boolean {
  return file.classification_status === "classified";
}

function FileCard({
  file,
  index,
  onError,
  t,
  compact = false,
  disableAnimation = false
}: {
  file: FileRecord;
  index: number;
  onError: (message: string) => void;
  t: Translator;
  compact?: boolean;
  disableAnimation?: boolean;
}) {
  return (
    <motion.div
      className={cn(
        rowSurface,
        "group grid w-full grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-3 hover:bg-white/50 dark:hover:bg-white/10",
        compact ? "p-3" : "p-4"
      )}
      layout={!disableAnimation}
      variants={disableAnimation ? undefined : itemMotion}
      initial={disableAnimation ? false : undefined}
      animate={disableAnimation ? false : undefined}
      style={{ "--delay": `${Math.min(index * 18, 320)}ms` } as CSSProperties}
    >
      <File size={18} />
      <span className="min-w-0">
        <strong className="block truncate text-sm">{file.name}</strong>
        <small className="block text-xs text-[var(--muted)]">{file.purpose} / {formatBytes(file.size)}</small>
      </span>
      <button
        type="button"
        className="grid h-8 w-8 place-items-center rounded-lg border border-[var(--line)] bg-white/60 text-[var(--muted)] opacity-0 shadow-sm transition hover:border-blue-400/60 hover:bg-blue-500/10 hover:text-blue-600 focus:opacity-100 group-hover:opacity-100 dark:bg-slate-900/60 dark:hover:text-blue-300"
        aria-label={t("revealPhysical")}
        title={t("revealPhysical")}
        onClick={(event) => {
          void revealFileFromCard({
            path: file.path,
            onError,
            stopPropagation: () => event.stopPropagation()
          });
        }}
      >
        <FolderOpen size={15} />
      </button>
      <em className={cn("rounded-full border px-2 py-1 text-xs not-italic", toneClasses(file.risk_level === "Sensitive" ? "red" : "green"))}>{file.risk_level === "Sensitive" ? t("sensitiveLabel") : t("normal")}</em>
    </motion.div>
  );
}
