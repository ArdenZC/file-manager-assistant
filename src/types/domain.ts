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

export type DispatchZone = "CoreAssets" | "QuietArchive" | "PrivacyVault" | "CleanupLane";
export type SearchSourceType = "user_space" | "folder" | "cloud" | "external";
export type RestoreStatus = "not_restored" | "restored" | "failed" | "unavailable" | "canceled";
export type ClassificationStatus = "unclassified" | "classified";
export type FolderNamingLanguage = "en" | "zh";
export type CloseBehavior = "ask" | "minimize" | "quit";
export type RestoreRetentionDays = 15 | 30 | 60 | 90;

export interface ScanRootSetting {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
  createdAt: string;
}

export type LibraryScope =
  | { kind: "current_scan"; roots: string[]; scanSessionId?: string }
  | { kind: "roots"; roots: string[] }
  | { kind: "all" };

export interface AppSettings {
  closeBehavior: CloseBehavior;
  folderNamingLanguage: FolderNamingLanguage;
  defaultScanFolders: ScanRootSetting[];
  restoreRetentionDays: RestoreRetentionDays;
  launchAtLogin: boolean;
}

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
  classification_status: ClassificationStatus;
  matched_rules: string[];
  requires_confirmation: boolean;
  dispatch_zone?: DispatchZone;
  recommended_folder?: string;
  folder_reuse_candidate?: string;
  folder_rename_suggestion?: string;
  dispatch_reason?: string;
  next_action?: string;
  last_opened_at?: string | null;
  open_count?: number;
  indexed_at?: string;
  source_id?: string;
  is_stale?: boolean;
}

export interface ScanRoot {
  id: string;
  path: string;
  platform: NodeJS.Platform | string;
  enabled: boolean;
  last_scanned_at: string | null;
  created_at: string;
  disk_total_size?: number | null;
  disk_free_size?: number | null;
  scanned_size?: number;
  indexed_file_count?: number;
  skipped_count?: number;
  summarized_count?: number;
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
  roots?: string[];
  limit?: number;
  offset?: number;
}

export interface FileQueryResult {
  files: FileRecord[];
  total: number;
  limit: number;
  offset: number;
}

export interface DashboardStats {
  totalFiles: number;
  totalSize: number;
  diskTotalSize: number;
  diskFreeSize: number;
  diskUsageRatio: number;
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
  selected_by_default?: boolean;
  is_executable?: boolean;
  blocking_reason?: string;
  editable_new_name?: boolean;
  batch_id?: string;
}

export interface OperationLog {
  id: string;
  batch_id: string;
  operation_type: string;
  source_path: string;
  target_path: string;
  old_name: string;
  new_name: string;
  status: "success" | "failed" | "skipped";
  error_message: string | null;
  created_at: string;
  can_undo: boolean;
  path_before: string;
  path_after: string;
  name_before: string;
  name_after: string;
  can_restore: boolean;
  restored_at: string | null;
  restore_status: RestoreStatus;
  restore_error: string | null;
}

export interface ExecuteOperationRequest {
  operations: OperationPreview[];
}

export interface ExecuteOperationResult {
  logs: OperationLog[];
  updatedFiles: FileRecord[];
  batch_id: string;
}

export interface RestoreMovesResult {
  logs: OperationLog[];
  restored: number;
  failed: number;
}

export interface SearchSource {
  id: string;
  label: string;
  path: string;
  type: SearchSourceType;
  enabled: boolean;
  is_stale: boolean;
  indexed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SearchIndexState {
  total_files: number;
  indexed_files: number;
  last_indexed_at: string | null;
  stale_sources: number;
}

export interface SearchQuery {
  query: string;
  limit?: number;
  sourceIds?: string[];
}

export interface SearchResult {
  file: FileRecord;
  score: number;
  matched_text: string;
}

export interface RestoreBatch {
  batch_id: string;
  created_at: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  restorable: number;
  restored: number;
  expires_at: string;
}

export interface RestorePreviewItem {
  log_id: string;
  batch_id: string;
  operation_type: string;
  current_path: string;
  restore_path: string;
  old_name: string;
  new_name: string;
  can_restore: boolean;
  blocking_reason: string | null;
}

export interface RestorePreview {
  batch_id: string;
  items: RestorePreviewItem[];
}

export interface RestoreBatchResult {
  batch_id: string;
  restored: number;
  failed: number;
  skipped: number;
  items: RestorePreviewItem[];
}

export interface ScanResult {
  roots: ScanRoot[];
  files: FileRecord[];
  skipped: Array<{ path: string; reason: string }>;
  scannedAt: string;
  canceled?: boolean;
}

export interface FolderScanResult extends ScanResult {
  canceled: boolean;
  selectedPaths: string[];
}

export type ScanPhase = "queued" | "scanning" | "indexing" | "done" | "canceled" | "error";

export interface ScanProgress {
  scanId: string;
  phase: ScanPhase;
  currentPath: string | null;
  scannedFiles: number;
  indexedFiles: number;
  skipped: number;
  summarized: number;
  rootsTotal: number;
  rootsDone: number;
  message?: string;
}

export interface AppSnapshot {
  stats: DashboardStats;
  files: FileRecord[];
  rules: Rule[];
  operations: OperationLog[];
  scanRoots: ScanRoot[];
  searchSources: SearchSource[];
  searchIndex: SearchIndexState;
}
