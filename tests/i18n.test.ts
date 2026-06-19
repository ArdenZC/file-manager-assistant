import { describe, expect, it } from "vitest";
import { makeTranslator } from "../src/i18n";

describe("makeTranslator", () => {
  it("falls back to the key string when a translation is missing", () => {
    const t = makeTranslator("zh");

    expect(t("missing.translation" as Parameters<typeof t>[0])).toBe("missing.translation");
  });
});
