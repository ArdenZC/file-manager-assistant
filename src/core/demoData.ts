import os from "node:os";
import path from "node:path";
import type { FileRecord } from "../types/domain.js";
import { getExtension, getFileType } from "./fileTypes.js";
import { nowIso, stableId } from "./id.js";
import { applyAllRulesToFiles } from "./ruleEngine.js";

const demoNames = [
  "resume_2026.pdf",
  "invoice_apple.pdf",
  "passport_scan.jpg",
  "setup.exe",
  "UNSW_COMP9900_Final_Report.pdf",
  "Screenshot 2026-06-15 at 10.22.01.png",
  "project_notes.md",
  "archive_backup.zip"
];

export function createDemoFiles(): FileRecord[] {
  const now = nowIso();
  const base = path.join(os.homedir(), "Downloads");
  const files = demoNames.map((name, index) => {
    const filePath = path.join(base, name);
    const modified = new Date(Date.now() - index * 9 * 86_400_000).toISOString();
    return {
      id: stableId(filePath),
      name,
      path: filePath,
      directory: base,
      extension: getExtension(name),
      size: (index + 1) * 2_400_000,
      file_type: getFileType(name),
      purpose: "Unknown" as const,
      lifecycle: "Reference" as const,
      context: "",
      risk_level: "Unknown" as const,
      hash: null,
      created_at: modified,
      modified_at: modified,
      scanned_at: now,
      last_seen_at: now,
      is_hidden: false,
      is_deleted: false,
      is_duplicate: index === 6 || index === 7,
      suggested_action: "Keep" as const,
      suggested_target_path: "",
      suggested_name: name,
      confidence: 0,
      classification_reason: "",
      matched_rules: [],
      requires_confirmation: false
    };
  });
  return applyAllRulesToFiles(files, []);
}

