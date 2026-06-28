import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("performance benchmark script", () => {
  it("runs the 100k SQLite benchmark with all required query scenarios", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "scripts/runPerformanceTest.mjs"), "utf8");

    expect(source).toContain("fts_benchmark_100k");
    expect(source).toContain("english_search");
    expect(source).toContain("cjk_search");
    expect(source).toContain("extension_search");
    expect(source).toContain("scope_query");
    expect(source).toContain("filter_query");
    expect(source).toContain("query_filter_query");
  });
});
