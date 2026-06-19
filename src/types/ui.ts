import type { makeTranslator } from "../i18n.js";

export type View = "scanner" | "organize" | "library" | "preview" | "rules" | "restore" | "settings";
export type ThemeMode = "system" | "light" | "dark";
export type Translator = ReturnType<typeof makeTranslator>;
export type { CloseBehavior } from "./domain";
