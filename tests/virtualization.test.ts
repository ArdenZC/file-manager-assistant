import { describe, expect, it } from "vitest";
import { shouldVirtualizeList, VIRTUAL_LIST_THRESHOLD } from "../src/utils/virtualization";

describe("virtual list strategy", () => {
  it("enables virtual rendering only after the long-list threshold", () => {
    expect(VIRTUAL_LIST_THRESHOLD).toBe(100);
    expect(shouldVirtualizeList(100)).toBe(false);
    expect(shouldVirtualizeList(101)).toBe(true);
  });
});
