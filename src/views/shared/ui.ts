import type { Variants } from "motion/react";
import { cn, glassPanel, toneClasses } from "../../utils/tw";

export const listMotion: Variants = {
  hidden: {},
  show: {
    transition: {
      staggerChildren: 0.035,
      delayChildren: 0.03
    }
  }
};

export const itemMotion: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.985, filter: "blur(3px)" },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    filter: "blur(0px)",
    transition: { type: "spring", stiffness: 280, damping: 26 }
  }
};

export const pageSurface = "h-full min-h-0 overflow-auto pr-1";
export const panelSurface = cn(glassPanel, "min-h-0 p-5");
export const rowSurface =
  "rounded-2xl border border-[var(--line)] bg-white/30 p-3 text-left shadow-sm transition dark:bg-white/5";
export const compactRowSurface =
  "rounded-xl border border-[var(--line)] bg-white/30 px-3 py-2 text-left transition dark:bg-white/5";
export const mutedText = "text-sm text-[var(--muted)]";
export const quietText = "text-xs text-[var(--quiet)]";
export const formGrid = "grid grid-cols-2 gap-3 [&_label]:grid [&_label]:gap-1.5 [&_label]:text-sm [&_label]:font-medium [&_label]:text-[var(--muted)]";
export const segmented = "inline-flex items-center gap-1 rounded-xl border border-[var(--line)] bg-white/25 p-1 dark:bg-white/5";

export function segmentButton(active: boolean): string {
  return cn(
    "rounded-lg px-3 py-1.5 text-sm text-[var(--muted)] transition hover:bg-white/50 hover:text-[var(--ink)] dark:hover:bg-white/10",
    active && "bg-blue-500 text-white shadow-sm hover:bg-blue-500 hover:text-white"
  );
}

export function toggleSwitch(on: boolean): string {
  return cn(
    "relative h-7 w-12 rounded-full border border-[var(--line)] bg-slate-300/50 transition disabled:cursor-not-allowed disabled:opacity-60 dark:bg-white/10 [&_i]:absolute [&_i]:left-1 [&_i]:top-1 [&_i]:h-5 [&_i]:w-5 [&_i]:rounded-full [&_i]:bg-white [&_i]:shadow-sm [&_i]:transition",
    on && "bg-blue-500 [&_i]:translate-x-5"
  );
}

export function sourceBadge(source: string): string {
  return cn(
    "rounded-full border px-2 py-1 text-xs font-medium",
    source === "user" || source === "user_space" ? toneClasses("green") : toneClasses("blue")
  );
}

