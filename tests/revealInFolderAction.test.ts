import { describe, expect, it, vi } from "vitest";
import { revealFileFromCard } from "../src/views/shared/cardActions";

describe("reveal in folder card action", () => {
  it("stops card selection and reports reveal failures", async () => {
    const onError = vi.fn();
    const stopPropagation = vi.fn();
    const reveal = vi.fn(async () => {
      throw new Error("missing path");
    });

    await revealFileFromCard({
      path: "C:\\Users\\Ada\\missing.pdf",
      onError,
      stopPropagation,
      reveal
    });

    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(reveal).toHaveBeenCalledWith("C:\\Users\\Ada\\missing.pdf");
    expect(onError).toHaveBeenCalledWith("missing path");
  });
});
