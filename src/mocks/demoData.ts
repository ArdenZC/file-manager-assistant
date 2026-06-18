import type { AppSnapshot, FileQueryResult, FileRecord, Rule } from "../types/domain";

export const demoFiles = createDemoFiles();
export const demoSnapshot: AppSnapshot = {
  stats: {
    totalFiles: demoFiles.length,
    totalSize: demoFiles.reduce((sum, file) => sum + file.size, 0),
    diskTotalSize: 512 * 1024 * 1024 * 1024,
    diskFreeSize: 384 * 1024 * 1024 * 1024,
    diskUsageRatio: demoFiles.reduce((sum, file) => sum + file.size, 0) / (512 * 1024 * 1024 * 1024),
    duplicateFiles: demoFiles.filter((file) => file.is_duplicate).length,
    largeFiles: 1,
    sensitiveFiles: demoFiles.filter((file) => file.risk_level === "Sensitive").length,
    needsConfirmation: demoFiles.filter((file) => file.requires_confirmation).length,
    byType: demoFiles.reduce<Record<string, number>>((acc, file) => {
      acc[file.file_type] = (acc[file.file_type] ?? 0) + 1;
      return acc;
    }, {}),
    byLifecycle: demoFiles.reduce<Record<string, number>>((acc, file) => {
      acc[file.lifecycle] = (acc[file.lifecycle] ?? 0) + 1;
      return acc;
    }, {}),
    lastScannedAt: null
  },
  files: demoFiles,
  rules: createDemoRules(),
  operations: [],
  scanRoots: [],
  searchSources: [
    {
      id: "demo-source",
      label: "Downloads",
      path: "C:/Users/example/Downloads",
      type: "user_space",
      enabled: true,
      is_stale: false,
      indexed_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }
  ],
  searchIndex: {
    total_files: demoFiles.length,
    indexed_files: demoFiles.length,
    last_indexed_at: null,
    stale_sources: 0
  }
};
export const demoFilePage: FileQueryResult = {
  files: demoFiles.slice(0, 50),
  total: demoFiles.length,
  limit: 50,
  offset: 0
};

function createDemoFiles(): FileRecord[] {
  const now = new Date().toISOString();
  const files: Array<Partial<FileRecord> & Pick<FileRecord, "name" | "file_type" | "purpose" | "lifecycle" | "risk_level" | "suggested_action" | "confidence" | "classification_reason">> = [
    {
      name: "resume_2026.pdf",
      file_type: "Document",
      purpose: "Career",
      lifecycle: "Reference",
      risk_level: "Normal",
      suggested_action: "Move",
      confidence: 0.84,
      classification_reason: "Matched Career and resume files"
    },
    {
      name: "invoice_apple.pdf",
      file_type: "Document",
      purpose: "Finance",
      lifecycle: "Reference",
      risk_level: "Sensitive",
      suggested_action: "Review",
      confidence: 0.78,
      classification_reason: "Matched Finance and receipt files; sensitive files require manual confirmation"
    },
    {
      name: "passport_scan.jpg",
      file_type: "Image",
      purpose: "Identity",
      lifecycle: "Sensitive",
      risk_level: "Sensitive",
      suggested_action: "Review",
      confidence: 0.92,
      classification_reason: "Matched Sensitive identity documents; sensitive files require manual confirmation"
    },
    {
      name: "setup.exe",
      file_type: "Installer",
      purpose: "Installer",
      lifecycle: "Disposable",
      risk_level: "Normal",
      suggested_action: "Review",
      confidence: 0.68,
      classification_reason: "Matched Installers and setup packages"
    },
    {
      name: "UNSW_COMP9900_Final_Report.pdf",
      file_type: "Document",
      purpose: "Study",
      lifecycle: "Archive",
      risk_level: "Normal",
      suggested_action: "Move",
      confidence: 0.72,
      classification_reason: "Matched Study material and coursework"
    },
    {
      name: "Screenshot 2026-06-15 at 10.22.01.png",
      file_type: "Image",
      purpose: "Media",
      lifecycle: "Inbox",
      risk_level: "Normal",
      suggested_action: "Rename",
      confidence: 0.62,
      classification_reason: "Matched Downloads and desktop inbox"
    }
  ];

  return files.map((file, index) => {
    const directory = "C:/Users/example/Downloads";
    const path = `${directory}/${file.name}`;
    const extension = file.name.split(".").pop() ?? "";
    return {
      id: `demo_${index}`,
      name: file.name,
      path,
      directory,
      extension,
      size: (index + 1) * 2_400_000,
      file_type: file.file_type,
      purpose: file.purpose,
      lifecycle: file.lifecycle,
      context: file.context ?? file.purpose,
      risk_level: file.risk_level,
      hash: null,
      created_at: now,
      modified_at: new Date(Date.now() - index * 8 * 86_400_000).toISOString(),
      scanned_at: now,
      last_seen_at: now,
      is_hidden: false,
      is_deleted: false,
      is_duplicate: false,
      suggested_action: file.suggested_action,
      suggested_target_path:
        file.suggested_action === "Move" ? `C:/Users/example/ZenCanvas/${file.purpose}` : "",
      suggested_name:
        file.suggested_action === "Rename" ? "screenshot_20260615_001.png" : file.name,
      confidence: file.confidence,
      classification_reason: file.classification_reason,
      matched_rules: [file.classification_reason.replace("; sensitive files require manual confirmation", "")],
      requires_confirmation: file.risk_level === "Sensitive" || file.suggested_action === "Review",
      dispatch_zone:
        file.risk_level === "Sensitive"
          ? "PrivacyVault"
          : file.lifecycle === "Archive"
            ? "QuietArchive"
            : file.lifecycle === "Disposable"
              ? "CleanupLane"
              : "CoreAssets",
      recommended_folder: `C:/Users/example/Downloads/ZenCanvas/${file.purpose}`,
      dispatch_reason: `${file.purpose}/${file.lifecycle}/${file.risk_level}`,
      next_action: file.risk_level === "Sensitive" ? "Review only" : "Send to preview",
      indexed_at: now,
      source_id: "demo-source",
      is_stale: false,
      open_count: 0,
      last_opened_at: null
    };
  });
}

function createDemoRules(): Rule[] {
  const now = new Date().toISOString();
  return [
    demoRule("system_career", "Career and resume files", "system", 90, 84),
    demoRule("system_finance", "Finance and receipt files", "system", 80, 80),
    demoRule("system_identity", "Sensitive identity documents", "system", 100, 95),
    {
      ...demoRule("user_screenshots", "Screenshots to Inbox", "user", 75, 76),
      action: {
        purpose: "Temporary" as const,
        lifecycle: "Inbox" as const,
        suggested_action: "Move" as const,
        target_template: "00_Inbox/Screenshots",
        context: "Screenshots"
      }
    }
  ].map((rule) => ({ ...rule, created_at: now, updated_at: now }));
}

function demoRule(
  id: string,
  name: string,
  source: Rule["source"],
  priority: number,
  weight: number
): Rule {
  const now = new Date().toISOString();
  return {
    id,
    name,
    source,
    enabled: true,
    priority,
    weight,
    root_operator: "AND",
    groups: [
      {
        id: `${id}_group`,
        operator: "AND",
        conditions: [{ id: `${id}_cond`, field: "name", operator: "contains", value: name.split(" ")[0] }]
      }
    ],
    action: { suggested_action: "Move", target_template: "00_Inbox" },
    created_at: now,
    updated_at: now
  };
}
