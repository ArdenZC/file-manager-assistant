export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(" ");
}

export const glassPanel =
  "rounded-2xl border border-[var(--line)] bg-[linear-gradient(135deg,var(--surface),var(--surface-soft))] shadow-[var(--shadow)] backdrop-blur-3xl";

export const glassButton =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-xl border border-[var(--line)] bg-white/40 px-4 py-2 text-sm font-medium text-[var(--ink)] shadow-sm transition hover:-translate-y-0.5 hover:bg-white/60 disabled:pointer-events-none disabled:opacity-55 dark:bg-white/5 dark:hover:bg-white/10";

export const glassButtonPrimary = cn(
  glassButton,
  "border-blue-400/60 bg-blue-500 text-white shadow-blue-500/20 hover:bg-blue-500 dark:bg-blue-500 dark:hover:bg-blue-400"
);

export const inputSurface =
  "min-h-10 rounded-xl border border-[var(--line)] bg-white/40 px-3 text-sm text-[var(--ink)] outline-none transition placeholder:text-[var(--quiet)] focus:border-blue-400/70 focus:bg-white/70 dark:bg-white/5 dark:focus:bg-white/10";

export const selectSurface = cn(inputSurface, "appearance-auto");

export const sectionTitle =
  "mb-4 flex items-start justify-between gap-4 [&_h2]:m-0 [&_h2]:text-lg [&_h2]:font-semibold [&_p]:mt-1 [&_p]:text-sm [&_p]:text-[var(--muted)]";

export const emptyState =
  "flex min-h-28 items-center justify-center rounded-2xl border border-dashed border-[var(--line)] bg-white/20 px-4 py-6 text-center text-sm text-[var(--muted)] dark:bg-white/5";

export const virtualList = "relative overflow-auto overscroll-contain";
export const virtualSpacer = "relative w-full";
export const virtualRow = "absolute left-0 top-0 w-full";

export const statusToast =
  "mb-3 rounded-xl border border-[var(--line)] bg-[linear-gradient(135deg,var(--surface),var(--surface-soft))] px-4 py-3 text-sm text-[var(--muted)] shadow-[var(--shadow)] backdrop-blur-3xl";

export function toastTone(type: "success" | "error" | "info"): string {
  if (type === "success") return "border-l-4 border-l-green-600";
  if (type === "error") return "border-l-4 border-l-red-600 bg-red-600/10";
  return "border-l-4 border-l-blue-600";
}

export function toneClasses(tone: string): string {
  if (tone === "red") return "border-red-400/30 bg-red-500/10 text-red-600 dark:text-red-300";
  if (tone === "purple") return "border-violet-400/30 bg-violet-500/10 text-violet-600 dark:text-violet-300";
  if (tone === "green") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300";
  if (tone === "slate") return "border-slate-400/30 bg-slate-500/10 text-slate-600 dark:text-slate-300";
  return "border-blue-400/30 bg-blue-500/10 text-blue-600 dark:text-blue-300";
}
