import { memo } from "react";
import { motion } from "motion/react";
import { File } from "lucide-react";
import type { OperationPreview } from "../../types/domain";
import type { Translator } from "../../types/ui";
import { percent } from "../../utils/format";
import { cn, inputSurface } from "../../utils/tw";
import { compactRowSurface, itemMotion } from "../shared/ui";

export const PreviewFileRow = memo(function PreviewFileRow({
  preview,
  isSelected,
  toggle,
  onRenamePreview,
  t
}: {
  preview: OperationPreview;
  isSelected: boolean;
  toggle: (id: string) => void;
  onRenamePreview: (id: string, name: string) => void;
  t: Translator;
}) {
  return (
    <motion.div className={cn(compactRowSurface, "grid grid-cols-[auto_auto_minmax(0,1fr)] items-start gap-3")} layout variants={itemMotion}>
      <input
        type="checkbox"
        disabled={preview.is_executable === false}
        checked={isSelected}
        onChange={() => toggle(preview.id)}
      />
      <File size={15} />
      <div className="min-w-0">
        <strong className="block truncate text-sm">{preview.old_name}</strong>
        <span className="block text-xs text-[var(--muted)]">{preview.operation_type} / {percent(preview.confidence)}</span>
        <div className="mt-1 flex flex-wrap gap-1 text-[11px]">
          {preview.requires_confirmation && (
            <span className="rounded-full border border-amber-400/50 bg-amber-500/10 px-2 py-0.5 text-amber-700 dark:text-amber-200">
              {t("confirmationItems")}
            </span>
          )}
          {preview.blocking_reason && (
            <span className="rounded-full border border-red-400/50 bg-red-500/10 px-2 py-0.5 text-red-700 dark:text-red-200">
              {preview.blocking_reason}
            </span>
          )}
          {preview.will_create_parent && (
            <span className="rounded-full border border-blue-400/50 bg-blue-500/10 px-2 py-0.5 text-blue-700 dark:text-blue-200">
              {t("autoCreateFolders")}
            </span>
          )}
        </div>
        <code className="mt-1 block truncate rounded bg-slate-500/10 px-2 py-1 text-[11px] text-[var(--muted)]" title={preview.source_path}>{preview.source_path}</code>
        <code className="mt-1 block truncate rounded bg-blue-500/10 px-2 py-1 text-[11px] text-blue-600 dark:text-blue-300" title={preview.target_path}>{preview.target_path}</code>
        <input
          className={cn(inputSurface, "mt-2 w-full")}
          value={preview.new_name}
          disabled={!preview.editable_new_name || preview.is_executable === false}
          onChange={(event) => onRenamePreview(preview.id, event.target.value)}
          aria-label={t("newFileName")}
        />
      </div>
    </motion.div>
  );
});

