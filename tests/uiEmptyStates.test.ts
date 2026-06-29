import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeTranslator } from "../src/i18n";

function read(relativePath: string) {
  return readFileSync(resolve(relativePath), "utf8");
}

describe("ui empty and command states", () => {
  it("uses dedicated command search messages instead of operation copy", () => {
    const commandModal = read("src/components/CommandModal.tsx");
    const t = makeTranslator("zh");

    expect(t("commandNoResults")).toContain("没有找到匹配文件");
    expect(t("commandSearching")).toBe("搜索中…");
    expect(t("commandSearchFailed")).toContain("搜索失败");
    expect(commandModal).toContain('t("commandNoResults")');
    expect(commandModal).toContain('t("commandSearching")');
    expect(commandModal).toContain('t("commandSearchFailed")');
    expect(commandModal).not.toContain('t("noOperations")');
  });

  it("adds combobox/listbox/option aria wiring to command results", () => {
    const commandModal = read("src/components/CommandModal.tsx");

    expect(commandModal).toContain('role="combobox"');
    expect(commandModal).toContain('aria-expanded={showResults}');
    expect(commandModal).toContain('aria-controls="command-results"');
    expect(commandModal).toContain("aria-activedescendant");
    expect(commandModal).toContain('id="command-results"');
    expect(commandModal).toContain('role="listbox"');
    expect(commandModal).toContain('role="option"');
    expect(commandModal).toContain("aria-selected={index === activeIndex}");
    expect(commandModal).toContain("id={`command-result-${index}`}");
  });

  it("shows explicit empty current scan scope guidance in library and hub views", () => {
    const vault = read("src/views/vault/VaultView.tsx");
    const hub = read("src/views/hub/HubView.tsx");
    const t = makeTranslator("zh");

    expect(t("noCurrentScanTitle")).toBe("还没有当前扫描目录");
    expect(t("noOrganizeScopeTitle")).toBe("当前没有扫描范围");
    expect(vault).toContain("isEmptyCurrentScanScope");
    expect(vault).toContain('t("noCurrentScanTitle")');
    expect(vault).toContain('t("chooseFolderScan")');
    expect(vault).toContain('setScope({ kind: "all" })');
    expect(hub).toContain("isEmptyCurrentScanScope");
    expect(hub).toContain('t("noOrganizeScopeTitle")');
    expect(hub).toContain('t("viewAllIndexedFiles")');
  });

  it("shows the current library filter next to the library result count", () => {
    const vault = read("src/views/vault/VaultView.tsx");
    const t = makeTranslator("zh");

    expect(t("currentLibraryFilter")).toBe("当前筛选");
    expect(t("libraryFilterReview")).toBe("需要确认");
    expect(vault).toContain('t("currentLibraryFilter")');
    expect(vault).toContain("activeFilterLabel");
  });

  it("shows a guided empty preview state with navigation actions", () => {
    const timeline = read("src/views/timeline/TimelineView.tsx");
    const t = makeTranslator("zh");

    expect(t("previewEmptyTitle")).toBe("当前没有可执行整理建议");
    expect(t("goSmartDispatch")).toBe("前往智能整理");
    expect(timeline).toContain('t("previewEmptyTitle")');
    expect(timeline).toContain('t("previewEmptyDesc")');
    expect(timeline).toContain('setView("organize")');
    expect(timeline).toContain('setView("rules")');
  });
});
