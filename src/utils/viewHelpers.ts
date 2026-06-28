import type { AppSnapshot, FileQuery, FileRecord, LibraryScope, OperationPreview } from "../types/domain";
import type { Language } from "../i18n";
import type { ThemeMode, Translator } from "../types/ui";
import { DEFAULT_SEARCH_HOTKEY, formatHotkeyLabel } from "./hotkeys";

export function filterFiles(files: FileRecord[], query: FileQuery): FileRecord[] {
  const search = query.search?.toLowerCase().trim();
  const filtered = files.filter((file) => {
    if (search && !`${file.name} ${file.path} ${file.context}`.toLowerCase().includes(search)) return false;
    if (query.fileType && query.fileType !== "All" && file.file_type !== query.fileType) return false;
    if (query.purpose && query.purpose !== "All" && file.purpose !== query.purpose) return false;
    if (query.lifecycle && query.lifecycle !== "All" && file.lifecycle !== query.lifecycle) return false;
    if (query.riskLevel && query.riskLevel !== "All" && file.risk_level !== query.riskLevel) return false;
    if (query.onlyNeedsConfirmation && !file.requires_confirmation) return false;
    return true;
  });

  const sortBy = query.sortBy ?? "modified_at";
  const direction = query.sortDirection === "asc" ? 1 : -1;
  return [...filtered].sort((a, b) => {
    const left = a[sortBy];
    const right = b[sortBy];
    if (typeof left === "number" && typeof right === "number") return (left - right) * direction;
    return String(left).localeCompare(String(right)) * direction;
  });
}

export function splitDisplaySize(label: string) {
  const [value, ...unitParts] = label.split(" ");
  return {
    value: value || label,
    unit: unitParts.join(" ")
  };
}

export function compactPath(value: string | null | undefined, maxLength = 42) {
  if (!value) return "-";
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(8, Math.floor(maxLength * 0.45)))}...${value.slice(-Math.max(8, Math.floor(maxLength * 0.35)))}`;
}

export function libraryScopeLabel(scope: LibraryScope, allLabel: string, emptyLabel: string, maxLength = 64) {
  if (scope.kind === "all") return allLabel;
  if (!scope.roots.length) return emptyLabel;
  if (scope.roots.length === 1) return compactPath(scope.roots[0], maxLength);
  return `${compactPath(scope.roots[0], Math.max(32, maxLength - 10))} +${scope.roots.length - 1}`;
}

export function delay(ms: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

export function groupOperationPreviews(previews: OperationPreview[], t: Translator) {
  const groups = new Map<string, { path: string; items: OperationPreview[]; subgroups: Map<string, { path: string; items: OperationPreview[] }> }>();
  for (const preview of previews) {
    const directory = pathDirLike(preview.target_path);
    const relativeParts = relativeZenCanvasParts(directory);
    const firstSegment = relativeParts[0] ?? folderNameLike(directory);
    const mainKey = canonicalPreviewMainKey(firstSegment);
    const subgroupParts = isCanonicalPreviewMain(firstSegment) ? relativeParts.slice(1) : relativeParts;
    const subgroupKey = subgroupParts.length ? subgroupParts.join("/") : "__root__";
    const mainPath = `ZenCanvas/${mainKey}`;
    const subgroupPath = subgroupKey === "__root__" ? directory : `ZenCanvas/${mainKey}/${subgroupKey}`;
    const group = groups.get(mainKey) ?? {
      path: mainPath,
      items: [],
      subgroups: new Map<string, { path: string; items: OperationPreview[] }>()
    };
    group.items.push(preview);
    const subgroup = group.subgroups.get(subgroupKey) ?? { path: subgroupPath, items: [] };
    subgroup.items.push(preview);
    group.subgroups.set(subgroupKey, subgroup);
    groups.set(mainKey, group);
  }
  return [...groups.entries()].map(([key, group]) => ({
    key,
    path: group.path,
    name: previewMainFolderLabel(key, t),
    items: group.items,
    subgroups: [...group.subgroups.entries()].map(([subKey, subgroup]) => ({
      key: subKey,
      path: subgroup.path,
      name: subKey === "__root__" ? t("previewRootFiles") : prettyFolderName(subKey),
      items: subgroup.items
    }))
  }));
}

export function relativeZenCanvasParts(directory: string): string[] {
  const parts = directory.replace(/\\/g, "/").split("/").filter(Boolean);
  const zenIndex = parts.findIndex((part) => part.toLowerCase() === "zencanvas");
  if (zenIndex >= 0) return parts.slice(zenIndex + 1);
  return [folderNameLike(directory)];
}

export function canonicalPreviewMainKey(segment: string): string {
  if (isCanonicalPreviewMain(segment)) return segment;
  const normalized = segment.toLowerCase().replace(/^\d+_/, "");
  if (["career", "finance", "study", "work", "personal", "media", "project", "projects", "identity"].includes(normalized)) {
    return "20_Areas";
  }
  if (normalized.includes("archive") || normalized.includes("reference")) return "40_Archive";
  if (
    normalized.includes("temporary") ||
    normalized.includes("temp") ||
    normalized.includes("installer") ||
    normalized.includes("download") ||
    normalized.includes("screenshot")
  ) {
    return "90_Temporary";
  }
  if (normalized.includes("inbox")) return "00_Inbox";
  return "20_Areas";
}

export function isCanonicalPreviewMain(segment: string): boolean {
  const normalized = segment.toLowerCase();
  return normalized.startsWith("00_") || normalized.startsWith("20_") || normalized.startsWith("40_") || normalized.startsWith("90_");
}

export function previewMainFolderLabel(key: string, t: Translator): string {
  const normalized = key.toLowerCase();
  if (normalized.startsWith("00_") || normalized.includes("inbox")) return t("previewInboxFolder");
  if (normalized.startsWith("20_") || normalized.includes("areas")) return t("previewAreasFolder");
  if (normalized.startsWith("40_") || normalized.includes("archive")) return t("previewArchiveFolder");
  if (normalized.startsWith("90_") || normalized.includes("temporary")) return t("previewTemporaryFolder");
  return prettyFolderName(key);
}

export function prettyFolderName(value: string): string {
  return value
    .split("/")
    .map((part) => part.replace(/^\d+_/, "").replace(/[_-]+/g, " "))
    .join(" / ");
}

export function defaultPlatformAccelerator(platform: NodeJS.Platform | "browser"): string {
  return formatHotkeyLabel(DEFAULT_SEARCH_HOTKEY, platform);
}

export function createOperationPreviews(files: FileRecord[]): OperationPreview[] {
  return files
    .filter((file) => ["Move", "Rename", "MoveAndRename", "Archive"].includes(file.suggested_action))
    .filter((file) => file.risk_level !== "Sensitive")
    .map((file) => {
      const newName = file.suggested_name || file.name;
      const targetDirectory =
        file.suggested_target_path || (file.suggested_action === "Rename" ? file.directory : "");
      const targetPath = targetDirectory ? joinPathLike(targetDirectory, newName) : file.path;
      const isMove = Boolean(targetDirectory) && normalizePathLike(targetDirectory) !== normalizePathLike(file.directory);
      const isRename = newName !== file.name;
      const operationType: OperationPreview["operation_type"] =
        isMove && isRename ? "move_rename" : isMove ? "move" : "rename";
      const requiresConfirmation = file.requires_confirmation || file.confidence < 0.7;
      return {
        id: localId("op"),
        fileId: file.id,
        operation_type: operationType,
        source_path: file.path,
        target_path: targetPath,
        old_name: file.name,
        new_name: newName,
        status: "pending" as const,
        risk_level: file.risk_level,
        confidence: file.confidence,
        requires_confirmation: requiresConfirmation,
        reason: file.classification_reason,
        selected_by_default: !requiresConfirmation,
        is_executable: true,
        editable_new_name: true
      };
    })
    .filter((preview) => normalizePathLike(preview.source_path) !== normalizePathLike(preview.target_path));
}

export function applyPreviewNameOverride(preview: OperationPreview, name?: string): OperationPreview {
  const trimmed = name?.trim();
  if (!trimmed || trimmed === preview.new_name) return preview;
  const directory = pathDirLike(preview.target_path);
  return {
    ...preview,
    new_name: trimmed,
    target_path: joinPathLike(directory, trimmed),
    operation_type: normalizePathLike(directory) === normalizePathLike(pathDirLike(preview.source_path))
      ? "rename"
      : "move_rename"
  };
}

export function joinPathLike(directory: string, name: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/, "")}${separator}${name}`;
}

export function pathDirLike(filePath: string): string {
  const normalized = filePath.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index > 0 ? normalized.slice(0, index) : normalized;
}

export function folderNameLike(folderPath: string): string {
  const normalized = folderPath.replace(/[\\/]+$/, "");
  const index = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return index >= 0 ? normalized.slice(index + 1) || normalized : normalized;
}

export function normalizePathLike(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function fileBelongsToRoots(file: FileRecord, roots: string[]): boolean {
  const filePath = normalizePathLike(file.path);
  return roots.some((root) => {
    const normalizedRoot = normalizePathLike(root);
    return filePath === normalizedRoot || filePath.startsWith(`${normalizedRoot}/`);
  });
}

export function samePathLike(left: string, right: string): boolean {
  return normalizePathLike(left) === normalizePathLike(right);
}

export function sumUniqueDiskTotal(roots: AppSnapshot["scanRoots"]): number {
  const seen = new Set<string>();
  let total = 0;
  for (const root of roots) {
    const value = Number(root.disk_total_size ?? 0);
    if (!value) continue;
    const normalized = normalizePathLike(root.path);
    const volume = normalized.match(/^[a-z]:/)?.[0] ?? normalized.split("/")[0] ?? normalized;
    if (seen.has(volume)) continue;
    seen.add(volume);
    total += value;
  }
  return total;
}

export function preferredLanguage(): Language {
  if (typeof window === "undefined") return "zh";
  return window.localStorage.getItem("zc-language") === "en" || window.localStorage.getItem("fma-language") === "en"
    ? "en"
    : "zh";
}

export function preferredTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const stored = window.localStorage.getItem("zc-theme");
  if (stored === "light" || stored === "dark" || stored === "system") return stored;
  return "system";
}

export function prefersDarkScheme(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
}

export function detectBrowserPlatform(): NodeJS.Platform | "browser" {
  if (typeof navigator === "undefined") return "browser";
  const platform = navigator.platform.toLowerCase();
  const userAgent = navigator.userAgent.toLowerCase();
  if (platform.includes("win") || userAgent.includes("windows")) return "win32";
  if (platform.includes("mac") || userAgent.includes("mac os")) return "darwin";
  if (platform.includes("linux") || userAgent.includes("linux")) return "linux";
  return "browser";
}

export function readableError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function localId(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
