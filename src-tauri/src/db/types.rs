use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database pool error: {0}")]
    Pool(#[from] r2d2::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub(crate) struct IndexedFileRow {
    pub(crate) id: String,
    pub(crate) path: String,
    pub(crate) name: String,
    pub(crate) extension: String,
    pub(crate) size: i64,
    pub(crate) mtime: i64,
    pub(crate) ctime: i64,
    pub(crate) is_dir: bool,
    pub(crate) state_code: i64,
    pub(crate) file_type: String,
    pub(crate) purpose: String,
    pub(crate) lifecycle: String,
    pub(crate) context: String,
    pub(crate) risk_level: String,
    pub(crate) suggested_action: String,
    pub(crate) suggested_target_path: String,
    pub(crate) suggested_name: String,
    pub(crate) confidence: f64,
    pub(crate) classification_reason: String,
    pub(crate) classification_status: String,
    pub(crate) matched_rules: String,
    pub(crate) requires_confirmation: bool,
    pub(crate) content_hash: String,
    pub(crate) is_duplicate: bool,
    pub(crate) is_stale: bool,
    pub(crate) last_seen_at: i64,
    pub(crate) last_classified_at: i64,
    pub(crate) classified_rule_version: String,
    pub(crate) last_classified_mtime: i64,
    pub(crate) last_classified_size: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InsertFileRequest {
    pub id: String,
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: i64,
    pub mtime: i64,
    #[serde(default)]
    pub ctime: i64,
    pub is_dir: bool,
    pub state_code: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSearchResult {
    pub id: String,
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: i64,
    pub mtime: i64,
    pub is_dir: bool,
    pub state_code: i64,
    pub rank: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct FileRecordDto {
    pub id: String,
    pub name: String,
    pub path: String,
    pub directory: String,
    pub extension: String,
    pub size: i64,
    pub file_type: String,
    pub purpose: String,
    pub lifecycle: String,
    pub context: String,
    pub risk_level: String,
    pub hash: Option<String>,
    pub created_at: String,
    pub modified_at: String,
    pub scanned_at: String,
    pub last_seen_at: String,
    pub is_hidden: bool,
    pub is_deleted: bool,
    pub is_duplicate: bool,
    pub suggested_action: String,
    pub suggested_target_path: String,
    pub suggested_name: String,
    pub confidence: f64,
    pub classification_reason: String,
    pub classification_status: String,
    pub matched_rules: Vec<String>,
    pub requires_confirmation: bool,
    pub last_opened_at: Option<String>,
    pub open_count: i64,
    pub indexed_at: String,
    pub source_id: Option<String>,
    pub is_stale: bool,
    pub state_code: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PagedFilesResult {
    pub files: Vec<FileRecordDto>,
    pub total: i64,
    pub limit: u32,
    pub offset: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperationPreviewDto {
    pub id: String,
    #[serde(rename = "fileId")]
    pub file_id: String,
    pub operation_type: String,
    pub source_path: String,
    pub target_path: String,
    pub old_name: String,
    pub new_name: String,
    pub status: String,
    pub risk_level: String,
    pub confidence: f64,
    pub requires_confirmation: bool,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_by_default: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_executable: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blocking_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub editable_new_name: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_parent_exists: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub will_create_parent: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OperationPreviewScopeResult {
    pub previews: Vec<OperationPreviewDto>,
    pub total: i64,
    pub limit: u32,
    pub offset: u32,
    pub truncated: bool,
    pub has_more: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatsSummary {
    pub total_files: i64,
    pub total_size: i64,
    pub disk_total_size: i64,
    pub disk_free_size: i64,
    pub disk_usage_ratio: f64,
    pub duplicate_files: i64,
    pub large_files: i64,
    pub sensitive_files: i64,
    pub needs_confirmation: i64,
    pub by_type: HashMap<String, i64>,
    pub by_lifecycle: HashMap<String, i64>,
    pub last_scanned_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Rule {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub source: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub priority: f64,
    #[serde(default)]
    pub weight: f64,
    #[serde(default = "default_or", alias = "rootOperator")]
    pub root_operator: String,
    #[serde(default)]
    pub groups: Vec<RuleConditionGroup>,
    #[serde(default)]
    pub action: RuleAction,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuleConditionGroup {
    pub id: String,
    #[serde(default = "default_and")]
    pub operator: String,
    #[serde(default)]
    pub conditions: Vec<RuleCondition>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct RuleCondition {
    pub id: String,
    pub field: String,
    pub operator: String,
    pub value: Value,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct RuleAction {
    #[serde(default)]
    pub purpose: Option<String>,
    #[serde(default)]
    pub lifecycle: Option<String>,
    #[serde(default)]
    pub context: Option<String>,
    #[serde(default, alias = "riskLevel")]
    pub risk_level: Option<String>,
    #[serde(default, alias = "suggestedAction")]
    pub suggested_action: Option<String>,
    #[serde(default, alias = "targetTemplate")]
    pub target_template: Option<String>,
    #[serde(default, alias = "renameTemplate")]
    pub rename_template: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleExecutionSummary {
    pub scanned: i64,
    pub updated: i64,
    pub skipped: i64,
    pub needs_confirmation: i64,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RuleExecutionMode {
    InboxOnly,
    AllChangedOrRuleChanged,
}

impl Default for RuleExecutionMode {
    fn default() -> Self {
        Self::InboxOnly
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexOptimizeReport {
    pub trigger: String,
    pub duration_ms: u128,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum LibraryScope {
    CurrentScan {
        #[serde(default)]
        roots: Vec<String>,
        #[serde(default, rename = "scanSessionId")]
        scan_session_id: Option<String>,
    },
    Roots {
        #[serde(default)]
        roots: Vec<String>,
    },
    All,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLibraryFilter {
    #[serde(default)]
    pub library_filter: Option<LibraryFilter>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LibraryFilter {
    All,
    Active,
    Archive,
    Review,
}

pub(crate) struct RuleSqlRow {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) source: String,
    pub(crate) enabled: bool,
    pub(crate) priority: f64,
    pub(crate) weight: f64,
    pub(crate) root_operator: String,
    pub(crate) groups_json: String,
    pub(crate) action_json: String,
    pub(crate) created_at: String,
    pub(crate) updated_at: String,
}

#[derive(Debug, Clone)]
pub(crate) struct RuleCandidate {
    pub(crate) rule: Rule,
    pub(crate) score: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct BuiltinClassification {
    pub(crate) action: RuleAction,
    pub(crate) confidence: f64,
}

#[derive(Debug, Clone)]
pub(crate) struct ClassificationUpdate {
    pub(crate) file_type: String,
    pub(crate) purpose: String,
    pub(crate) lifecycle: String,
    pub(crate) context: String,
    pub(crate) risk_level: String,
    pub(crate) suggested_action: String,
    pub(crate) suggested_target_path: String,
    pub(crate) suggested_name: String,
    pub(crate) confidence: f64,
    pub(crate) classification_reason: String,
    pub(crate) classification_status: String,
    pub(crate) matched_rules: String,
    pub(crate) requires_confirmation: bool,
}

fn default_true() -> bool {
    true
}

fn default_or() -> String {
    "OR".to_string()
}

fn default_and() -> String {
    "AND".to_string()
}
