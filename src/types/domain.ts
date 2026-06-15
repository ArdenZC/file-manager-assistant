export type FileType =
  | "Document"
  | "Image"
  | "Video"
  | "Audio"
  | "Code"
  | "ArchivePackage"
  | "Installer"
  | "Spreadsheet"
  | "Presentation"
  | "Other";

export type Purpose =
  | "Project"
  | "Study"
  | "Work"
  | "Personal"
  | "Career"
  | "Finance"
  | "Identity"
  | "Media"
  | "Installer"
  | "Temporary"
  | "Archive"
  | "Unknown";

export type Lifecycle =
  | "Inbox"
  | "Active"
  | "Reference"
  | "Archive"
  | "Disposable"
  | "Duplicate"
  | "Sensitive";

export type RiskLevel = "Normal" | "Sensitive" | "System" | "Unknown";

export type SuggestedAction =
  | "Keep"
  | "Rename"
  | "Move"
  | "MoveAndRename"
  | "Archive"
  | "Review"
  | "DeleteCandidate";

export interface FileRecord {
  id: string;
  name: string;
  path: string;
  directory: string;
  extension: string;
  size: number;
  file_type: FileType;
  purpose: Purpose;
  lifecycle: Lifecycle;
  context: string;
  risk_level: RiskLevel;
  hash: string | null;
  created_at: string;
  modified_at: string;
  scanned_at: string;
  last_seen_at: string;
  is_hidden: boolean;
  is_deleted: boolean;
  is_duplicate: boolean;
  suggested_action: SuggestedAction;
  suggested_target_path: string;
  suggested_name: string;
  confidence: number;
  classification_reason: string;
  matched_rules: string[];
  requires_confirmation: boolean;
}

export interface ScanRoot {
  id: string;
  path: string;
  platform: NodeJS.Platform | string;
  enabled: boolean;
  last_scanned_at: string | null;
  created_at: string;
}

export type RuleSource = "system" | "user" | "session";
export type RuleOperator = "AND" | "OR";

export type ConditionField =
  | "name"
  | "extension"
  | "file_type"
  | "path"
  | "directory"
  | "size"
  | "modified_at"
  | "is_duplicate"
  | "risk_level";

export type ConditionOperator =
  | "contains"
  | "equals"
  | "startsWith"
  | "endsWith"
  | "greaterThan"
  | "lessThan"
  | "olderThanDays"
  | "newerThanDays"
  | "is";

export interface RuleCondition {
  id: string;
  field: ConditionField;
  operator: ConditionOperator;
  value: string | number | boolean;
}

export interface RuleConditionGroup {
  id: string;
  operator: RuleOperator;
  conditions: RuleCondition[];
}

export interface RuleAction {
  purpose?: Purpose;
  lifecycle?: Lifecycle;
  context?: string;
  risk_level?: RiskLevel;
  suggested_action?: SuggestedAction;
  target_template?: string;
  rename_template?: string;
}

export interface Rule {
  id: string;
  name: string;
  source: RuleSource;
  enabled: boolean;
  priority: number;
  weight: number;
  root_operator: RuleOperator;
  groups: RuleConditionGroup[];
  action: RuleAction;
  created_at: string;
  updated_at: string;
}

export interface FileQuery {
  search?: string;
  fileType?: FileType | "All";
  purpose?: Purpose | "All";
  lifecycle?: Lifecycle | "All";
  riskLevel?: RiskLevel | "All";
  sourceDirectory?: string;
  sortBy?: "name" | "size" | "modified_at" | "confidence";
  sortDirection?: "asc" | "desc";
  onlyActionable?: boolean;
  onlyNeedsConfirmation?: boolean;
}

export interface DashboardStats {
  totalFiles: number;
  totalSize: number;
  duplicateFiles: number;
  largeFiles: number;
  sensitiveFiles: number;
  needsConfirmation: number;
  byType: Record<string, number>;
  byLifecycle: Record<string, number>;
  lastScannedAt: string | null;
}

export interface OperationPreview {
  id: string;
  fileId: string;
  operation_type: "move" | "rename" | "move_rename";
  source_path: string;
  target_path: string;
  old_name: string;
  new_name: string;
  status: "pending" | "success" | "failed" | "skipped";
  risk_level: RiskLevel;
  confidence: number;
  requires_confirmation: boolean;
  reason: string;
}

export interface OperationLog {
  id: string;
  operation_type: string;
  source_path: string;
  target_path: string;
  old_name: string;
  new_name: string;
  status: "success" | "failed" | "skipped";
  error_message: string | null;
  created_at: string;
  can_undo: boolean;
}

export interface ExecuteOperationRequest {
  operations: OperationPreview[];
}

export interface ExecuteOperationResult {
  logs: OperationLog[];
  updatedFiles: FileRecord[];
}

export interface ScanResult {
  roots: ScanRoot[];
  files: FileRecord[];
  skipped: Array<{ path: string; reason: string }>;
  scannedAt: string;
}

export interface AppSnapshot {
  stats: DashboardStats;
  files: FileRecord[];
  rules: Rule[];
  operations: OperationLog[];
  scanRoots: ScanRoot[];
}

