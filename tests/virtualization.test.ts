import { describe, expect, it } from "vitest";
import {
  shouldTriggerLoadMore,
  shouldVirtualizeList,
  VIRTUAL_LIST_THRESHOLD
} from "../src/utils/virtualization";

describe("virtual list strategy", () => {
  it("enables virtual rendering only after the long-list threshold", () => {
    expect(VIRTUAL_LIST_THRESHOLD).toBe(100);
    expect(shouldVirtualizeList(100)).toBe(false);
    expect(shouldVirtualizeList(101)).toBe(true);
  });

  it("does not trigger load more when no additional page exists", () => {
    expect(shouldTriggerLoadMore(96, 100, false, false)).toBe(false);
  });

  it("does not trigger load more while a page is already loading", () => {
    expect(shouldTriggerLoadMore(96, 100, true, true)).toBe(false);
  });

  it("triggers load more when the last visible row reaches the threshold", () => {
    expect(shouldTriggerLoadMore(96, 100, true, false)).toBe(true);
  });

  it("does not trigger load more while far from the bottom", () => {
    expect(shouldTriggerLoadMore(95, 100, true, false)).toBe(false);
  });
});
