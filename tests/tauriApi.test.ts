import { beforeEach, describe, expect, it, vi } from "vitest";
import { tauriApi } from "../src/api/tauriApi";
import type { LibraryScope } from "../src/types/domain";

const apiMocks = vi.hoisted(() => ({
  invoke: vi.fn()
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: apiMocks.invoke
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn()
}));

describe("tauriApi", () => {
  beforeEach(() => {
    apiMocks.invoke.mockReset().mockResolvedValue({
      files: [],
      total: 0,
      limit: 50,
      offset: 0
    });
  });

  it("sends paged library filters alongside query and scope", async () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Downloads"] };

    await tauriApi.getPagedFiles(50, 25, "pdf", scope, { libraryFilter: "review" });

    expect(apiMocks.invoke).toHaveBeenCalledWith("get_paged_files", {
      limit: 50,
      offset: 25,
      query: "pdf",
      scope,
      filter: { libraryFilter: "review" }
    });
  });

  it("requests operation previews for a full library scope", async () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Downloads"] };

    await tauriApi.getOperationPreviewsForScope(scope, { libraryFilter: "active" }, 500, 1000);

    expect(apiMocks.invoke).toHaveBeenCalledWith("get_operation_previews_for_scope", {
      scope,
      filter: { libraryFilter: "active" },
      limit: 500,
      offset: 1000
    });
  });

  it("sends explicit rule execution mode for scoped rule runs", async () => {
    const scope: LibraryScope = { kind: "roots", roots: ["F:/Downloads"] };

    await tauriApi.executeRulesForScope(scope, [], "all_changed_or_rule_changed");

    expect(apiMocks.invoke).toHaveBeenCalledWith("execute_rules_for_scope", {
      scope,
      rules: [],
      mode: "all_changed_or_rule_changed"
    });
  });

  it("reads and refreshes global hotkey registration status", async () => {
    await tauriApi.getGlobalHotkeyStatus();
    await tauriApi.registerGlobalSearchHotkey("Alt+Space");

    expect(apiMocks.invoke).toHaveBeenNthCalledWith(1, "get_global_hotkey_status", undefined);
    expect(apiMocks.invoke).toHaveBeenNthCalledWith(2, "register_global_search_hotkey", {
      accelerator: "Alt+Space"
    });
  });
});
