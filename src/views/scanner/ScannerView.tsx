import type { CSSProperties } from "react";
import { FolderSearch, RefreshCw, X } from "lucide-react";
import { useChromeContext } from "../../contexts/AppContexts";
import { useFileLibraryStore } from "../../store/useFileLibraryStore";
import { useScanManagerStore } from "../../store/useScanManagerStore";
import { formatBytes, percent } from "../../utils/format";
import { compactPath, libraryScopeLabel, splitDisplaySize } from "../../utils/viewHelpers";
import { cn, glassButton, glassButtonPrimary, glassButtonWarning } from "../../utils/tw";
import { pageSurface, panelSurface, quietText } from "../shared/ui";

export function ScannerView() {
  const { t } = useChromeContext();
  const scope = useFileLibraryStore((state) => state.scope);
  const stats = useFileLibraryStore((state) => state.stats);
  const files = useFileLibraryStore((state) => state.libraryPage.files);
  const selectedFolders = useScanManagerStore((state) => state.selectedFolders);
  const isScanning = useScanManagerStore((state) => state.isScanning);
  const scanState = useScanManagerStore((state) => state.scanState);
  const handleChooseFolders = useScanManagerStore((state) => state.handleChooseFolders);
  const handleScan = useScanManagerStore((state) => state.handleScan);
  const cancelScan = useScanManagerStore((state) => state.cancelScan);
  const scanProgress = scanState.progress;
  const warningCount = scanProgress?.errors ?? 0;
  const scopedTotalSize = stats.totalSize;
  // 注意：此处计算的是"已索引数据占磁盘总容量的比例"（扫描覆盖率），
  // 与后端 StatsSummary.diskUsageRatio（真实磁盘占用率 = 1 - 可用/总）含义不同，
  // 命名相似但语义不同，此处刻意使用本地计算值。
  const scannedDiskCoverageRatio = stats.diskTotalSize > 0 ? Math.min(1, stats.totalSize / stats.diskTotalSize) : 0;
  const clutterItems = files.filter((file) => file.requires_confirmation || file.is_duplicate || file.size > 1024 * 1024 * 1024).length;
  const clutterRatio = files.length ? Math.min(1, clutterItems / files.length) : 0;
  const scopeLabel = libraryScopeLabel(scope, t("allIndexedFiles"), selectedFolders[0] ?? t("userSpaceHint"));
  const analysedSize = splitDisplaySize(formatBytes(scopedTotalSize));

  return (
    <div className={cn(pageSurface, "grid place-items-center gap-5 py-6 text-center")}>
      <section className="relative">
        <div
          className={cn(
            "grid h-72 w-72 place-items-center rounded-full p-4 shadow-[var(--shadow-strong)]",
            isScanning && "shadow-blue-500/12"
          )}
          style={{
            background: isScanning
              ? "linear-gradient(135deg, rgba(59,130,246,0.34), rgba(16,185,129,0.16))"
              : `conic-gradient(#3b82f6 0 ${Math.round(scannedDiskCoverageRatio * 100)}%, rgba(59,130,246,0.10) ${Math.round(scannedDiskCoverageRatio * 100)}% 100%)`
          } as CSSProperties}
        >
          <div className="grid h-full w-full place-items-center rounded-full border border-[var(--line)] bg-[var(--surface)] p-8 backdrop-blur-3xl">
            {isScanning ? (
              <div className="grid gap-4 text-center">
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600 dark:text-blue-300">{t("scanning")}</span>
                <strong className="text-4xl font-semibold text-[var(--ink)]">
                  {(scanProgress?.files ?? 0).toLocaleString()}
                </strong>
                <div className="grid grid-cols-2 gap-2 text-xs text-[var(--muted)]">
                  <span className="rounded-full border border-[var(--line)] bg-white/32 px-2 py-1 dark:bg-white/5">
                    {t("files")}
                  </span>
                  <span className="rounded-full border border-[var(--line)] bg-white/32 px-2 py-1 dark:bg-white/5">
                    {t("skipped")}: {(scanProgress?.skipped ?? 0).toLocaleString()}
                  </span>
                  {warningCount > 0 && (
                    <span className="col-span-2 rounded-full border border-amber-400/25 bg-amber-500/10 px-2 py-1 text-amber-700 dark:text-amber-200">
                      {t("scanWarnings").replace("{count}", warningCount.toLocaleString())}
                    </span>
                  )}
                </div>
              </div>
            ) : (
              <>
                <span className="text-xs font-semibold uppercase tracking-[0.18em] text-[var(--quiet)]">{t("totalAnalysed")}</span>
                <strong className="mt-2 block text-5xl font-semibold">
                  {analysedSize.value}
                  <span className="ml-1 text-base text-[var(--muted)]">{analysedSize.unit}</span>
                </strong>
                <div className="mt-4 inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white/40 px-3 py-1 text-sm text-[var(--muted)] dark:bg-white/5">
                  <i className="h-2 w-2 rounded-full bg-emerald-500" />
                  <span>{percent(scannedDiskCoverageRatio)}</span>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="grid w-full max-w-lg grid-cols-2 gap-3">
        <div className={cn(panelSurface, "p-4 text-left")}>
          <span className={quietText}>{t("files")}</span>
          <strong className="mt-1 block text-2xl text-blue-600 dark:text-blue-300">{stats.totalFiles.toLocaleString()}</strong>
        </div>
        <div className={cn(panelSurface, "p-4 text-left")}>
          <span className={quietText}>{t("clutterRatio")}</span>
          <strong className="mt-1 block text-2xl text-red-600 dark:text-red-300">{percent(clutterRatio)}</strong>
        </div>
      </section>

      <section className="flex items-center justify-center gap-3">
        <button className={glassButtonPrimary} onClick={handleScan} disabled={isScanning}>
          <RefreshCw size={18} />
          <span>{isScanning ? t("scanning") : t("scanCommon")}</span>
        </button>
        {isScanning ? (
          <button className={glassButtonWarning} onClick={cancelScan}>
            <X size={18} />
            <span>{t("cancelScan")}</span>
          </button>
        ) : (
          <button className={glassButton} onClick={handleChooseFolders}>
            <FolderSearch size={18} />
            <span>{t("chooseFolders")}</span>
          </button>
        )}
      </section>

      <p className="max-w-xl text-sm font-medium text-[var(--ink)]">{scopeLabel}</p>
      <p className="max-w-2xl text-sm text-[var(--muted)]">
        {isScanning && scanProgress
          ? t("scanProgressLine")
              .replace("{files}", scanProgress.files.toLocaleString())
              .replace("{skipped}", scanProgress.skipped.toLocaleString())
              .replace("{path}", compactPath(scanProgress.root))
          : t("diskUsageInScope").replace("{size}", formatBytes(scopedTotalSize)).replace("{disk}", formatBytes(stats.diskTotalSize))}
      </p>
      {!isScanning && warningCount > 0 && (
        <div className="max-w-xl rounded-xl border border-amber-400/35 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-200">
          {t("scanWarnings").replace("{count}", warningCount.toLocaleString())}
        </div>
      )}
    </div>
  );
}

