import { describe, expect, it } from "vitest";
import type { FileRecord } from "../src/types/domain";
import { groupFilesByHubBucket } from "../src/views/hub/HubView";

describe("HubView file buckets", () => {
  it("groups classified files into the same bucket rules used by HubView", () => {
    const files = [
      file({ id: "core", name: "core.pdf" }),
      file({ id: "archive", name: "archive.zip", lifecycle: "Archive" }),
      file({ id: "cleanup", name: "cleanup.tmp", suggested_action: "Review" }),
      file({ id: "delete", name: "delete.log", suggested_action: "DeleteCandidate" }),
      file({ id: "privacy", name: "passport.pdf", risk_level: "Sensitive" })
    ];

    const grouped = groupFilesByHubBucket(files);

    expect(grouped.CoreAssets.map((item) => item.id)).toEqual(["core"]);
    expect(grouped.QuietArchive.map((item) => item.id)).toEqual(["archive"]);
    expect(grouped.CleanupLane.map((item) => item.id)).toEqual(["cleanup", "delete"]);
    expect(grouped.PrivacyVault.map((item) => item.id)).toEqual(["privacy"]);
  });
});

function file(overrides: Partial<FileRecord>): FileRecord {
  return {
    id: "file",
    name: "file.txt",
    path: "/test/file.txt",
    directory: "/test",
    extension: "txt",
    size: 128,
    file_type: "Document",
    purpose: "Unknown",
    lifecycle: "Inbox",
    context: "",
    risk_level: "Normal",
    hash: null,
    created_at: "2026-06-21T00:00:00Z",
    modified_at: "2026-06-21T00:00:00Z",
    scanned_at: "2026-06-21T00:00:00Z",
    last_seen_at: "2026-06-21T00:00:00Z",
    is_hidden: false,
    is_deleted: false,
    is_duplicate: false,
    suggested_action: "Keep",
    suggested_target_path: "",
    suggested_name: "",
    confidence: 0.5,
    classification_reason: "",
    classification_status: "classified",
    matched_rules: [],
    requires_confirmation: false,
    ...overrides
  };
}
