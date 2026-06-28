export const DEFAULT_SEARCH_HOTKEY = "CmdOrCtrl+K";

const MODIFIER_LABELS: Record<string, { mac: string; other: string }> = {
  cmdorctrl: { mac: "⌘", other: "Ctrl" },
  commandorcontrol: { mac: "⌘", other: "Ctrl" },
  cmd: { mac: "⌘", other: "Cmd" },
  command: { mac: "⌘", other: "Cmd" },
  meta: { mac: "⌘", other: "Meta" },
  ctrl: { mac: "Ctrl", other: "Ctrl" },
  control: { mac: "Ctrl", other: "Ctrl" },
  alt: { mac: "Alt", other: "Alt" },
  option: { mac: "⌥", other: "Alt" },
  shift: { mac: "Shift", other: "Shift" }
};

const BLOCKED_KEYS = new Set(["escape", "tab", "enter"]);
const MODIFIER_KEYS = new Set(["control", "ctrl", "meta", "cmd", "command", "alt", "option", "shift"]);

export function formatHotkeyLabel(
  accelerator = DEFAULT_SEARCH_HOTKEY,
  platform: NodeJS.Platform | "browser" = "browser"
): string {
  const isMac = platform === "darwin";
  return acceleratorParts(accelerator)
    .map((part) => {
      const normalized = part.toLowerCase();
      const modifier = MODIFIER_LABELS[normalized];
      if (modifier) return isMac ? modifier.mac : modifier.other;
      return normalized === "space" ? "Space" : upperKey(part);
    })
    .join(" ");
}

export function matchesAcceleratorEvent(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  accelerator = DEFAULT_SEARCH_HOTKEY,
  platform: NodeJS.Platform | "browser" = "browser"
): boolean {
  const parsed = parseAccelerator(accelerator, platform);
  if (!parsed) return false;
  if (event.ctrlKey !== parsed.ctrl) return false;
  if (event.metaKey !== parsed.meta) return false;
  if (event.altKey !== parsed.alt) return false;
  if (event.shiftKey !== parsed.shift) return false;
  return normalizeEventKey(event.key) === parsed.key;
}

export function acceleratorFromKeyboardEvent(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
  platform: NodeJS.Platform | "browser" = "browser"
): string | null {
  const key = normalizeEventKey(event.key);
  if (!key || BLOCKED_KEYS.has(key) || MODIFIER_KEYS.has(key)) return null;

  const parts: string[] = [];
  const usesPrimary = platform === "darwin" ? event.metaKey : event.ctrlKey;
  if (usesPrimary) parts.push("CmdOrCtrl");
  else if (event.ctrlKey) parts.push("Ctrl");
  else if (event.metaKey) parts.push("Cmd");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key === " " ? "Space" : upperKey(key));

  const accelerator = parts.join("+");
  return isValidSearchHotkey(accelerator) ? accelerator : null;
}

export function isValidSearchHotkey(accelerator: string): boolean {
  const parts = acceleratorParts(accelerator);
  if (parts.length < 2) return false;
  const key = parts.at(-1)?.toLowerCase() ?? "";
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (!key || BLOCKED_KEYS.has(key) || MODIFIER_KEYS.has(key)) return false;
  return modifiers.some((modifier) => modifier in MODIFIER_LABELS);
}

function parseAccelerator(
  accelerator: string,
  platform: NodeJS.Platform | "browser"
): { key: string; ctrl: boolean; meta: boolean; alt: boolean; shift: boolean } | null {
  const parts = acceleratorParts(accelerator);
  if (!parts.length) return null;
  const key = normalizeAcceleratorKey(parts.at(-1) ?? "");
  const parsed = {
    key,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false
  };

  for (const part of parts.slice(0, -1)) {
    const modifier = part.toLowerCase();
    if (modifier === "cmdorctrl" || modifier === "commandorcontrol") {
      if (platform === "darwin") parsed.meta = true;
      else parsed.ctrl = true;
    } else if (modifier === "ctrl" || modifier === "control") {
      parsed.ctrl = true;
    } else if (modifier === "cmd" || modifier === "command" || modifier === "meta") {
      parsed.meta = true;
    } else if (modifier === "alt" || modifier === "option") {
      parsed.alt = true;
    } else if (modifier === "shift") {
      parsed.shift = true;
    }
  }

  return key ? parsed : null;
}

function acceleratorParts(accelerator: string): string[] {
  return accelerator
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
}

function normalizeAcceleratorKey(key: string): string {
  return key.toLowerCase() === "space" ? " " : key.toLowerCase();
}

function normalizeEventKey(key: string): string {
  return key === " " || key.toLowerCase() === "spacebar" ? " " : key.toLowerCase();
}

function upperKey(key: string): string {
  if (key === " ") return "Space";
  return key.length === 1 ? key.toUpperCase() : `${key.slice(0, 1).toUpperCase()}${key.slice(1)}`;
}
