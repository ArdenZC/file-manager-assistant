use crate::file_ops::OperationLogDto;
use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::Disks;
use tauri::{AppHandle, Emitter, Runtime, State};
use thiserror::Error;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

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

#[derive(Clone)]
pub struct Database {
    path: PathBuf,
    pool: Pool<SqliteConnectionManager>,
}

#[derive(Debug, Clone)]
struct IndexedFileRow {
    id: String,
    path: String,
    name: String,
    extension: String,
    size: i64,
    mtime: i64,
    ctime: i64,
    is_dir: bool,
    state_code: i64,
    file_type: String,
    purpose: String,
    lifecycle: String,
    context: String,
    risk_level: String,
    suggested_action: String,
    suggested_target_path: String,
    suggested_name: String,
    confidence: f64,
    classification_reason: String,
    matched_rules: String,
    requires_confirmation: bool,
    is_stale: bool,
    last_seen_at: i64,
    last_classified_at: i64,
    classified_rule_version: String,
    last_classified_mtime: i64,
    last_classified_size: i64,
}

const CLASSIFY_BATCH_SIZE: usize = 500;
const OPTIMIZE_AFTER_UPSERT_THRESHOLD: usize = 500;
pub const SEARCH_INDEX_OPTIMIZED_EVENT: &str = "search-index-optimized";

/// 当前期望的 schema 版本号，每次需要改动 schema 时 +1
const CURRENT_SCHEMA_VERSION: i32 = 8;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchIndexOptimizeReport {
    pub trigger: String,
    pub duration_ms: u128,
    pub success: bool,
    pub error: Option<String>,
}

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let manager = SqliteConnectionManager::file(&path).with_init(configure_connection);
        let pool = Pool::builder().max_size(8).build(manager)?;
        {
            let conn = pool.get()?;
            migrate(&conn)?;
        }

        Ok(Self { path, pool })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn init(&self) -> Result<(), DbError> {
        let conn = self.conn()?;
        migrate(&conn)
    }

    pub fn insert_file(&self, file: InsertFileRequest) -> Result<(), DbError> {
        self.insert_files(&[file])
    }

    pub fn insert_files(&self, files: &[InsertFileRequest]) -> Result<(), DbError> {
        if files.is_empty() {
            return Ok(());
        }

        let last_seen_at = current_unix_seconds();
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
            INSERT INTO files (
                id, path, name, extension, size, mtime, ctime, is_dir, state_code,
                file_type, suggested_name, is_stale, last_seen_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12)
            ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                name = excluded.name,
                extension = excluded.extension,
                size = excluded.size,
                mtime = excluded.mtime,
                ctime = excluded.ctime,
                is_dir = excluded.is_dir,
                state_code = excluded.state_code,
                file_type = excluded.file_type,
                suggested_name = CASE
                    WHEN files.suggested_name = '' OR files.suggested_name = files.name
                    THEN excluded.suggested_name
                    ELSE files.suggested_name
                END,
                is_stale = 0,
                last_seen_at = excluded.last_seen_at
            "#,
            )?;

            for file in files {
                let file_type = infer_file_type(&file.extension, file.is_dir);
                stmt.execute(params![
                    file.id,
                    file.path,
                    file.name,
                    file.extension,
                    file.size,
                    file.mtime,
                    file.ctime,
                    bool_to_i64(file.is_dir),
                    file.state_code,
                    file_type,
                    file.name,
                    last_seen_at
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Compatibility command path for watcher removals: mark matching files stale instead of
    /// deleting rows, so transient file-system events do not destroy index history.
    pub fn remove_files_by_paths(&self, paths: &[String]) -> Result<usize, DbError> {
        if paths.is_empty() {
            return Ok(0);
        }

        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let mut removed = 0;
        {
            let mut stmt = tx.prepare(
                r#"
                UPDATE files
                SET is_stale = 1
                WHERE is_stale = 0
                  AND (
                    path = ?1
                    OR path LIKE ?2 ESCAPE '~'
                    OR path LIKE ?3 ESCAPE '~'
                  )
                "#,
            )?;

            for path in paths
                .iter()
                .map(|path| path.trim())
                .filter(|path| !path.is_empty())
            {
                let path = trim_trailing_path_separators(path);
                if path.is_empty() {
                    continue;
                }

                let normalized_path = normalize_path_text(path);
                for candidate in path_lookup_candidates(path, &normalized_path) {
                    let escaped_path = escape_like_pattern(&candidate);
                    let slash_descendants = format!("{escaped_path}/%");
                    let backslash_descendants = format!("{escaped_path}\\%");
                    removed +=
                        stmt.execute(params![candidate, slash_descendants, backslash_descendants])?;
                }
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn upsert_files_by_paths(&self, paths: &[String]) -> Result<usize, DbError> {
        upsert_files_by_paths_with_optional_optimize(self, paths)
    }

    pub fn optimize_search_index(&self) -> Result<u128, DbError> {
        let started = Instant::now();
        let conn = self.conn()?;
        conn.execute_batch("PRAGMA optimize;")?;
        Ok(started.elapsed().as_millis())
    }

    pub fn update_file_after_successful_operation(
        &self,
        file_id: &str,
        source_path: &str,
        target_path: &str,
        new_name: &str,
    ) -> Result<bool, DbError> {
        self.update_file_record_after_path_change(
            path_lookup_candidates(file_id, source_path),
            target_path,
            new_name,
        )
    }

    pub fn update_file_after_successful_restore(
        &self,
        log: &OperationLogDto,
    ) -> Result<bool, DbError> {
        if log.restore_status != "restored" {
            return Ok(false);
        }

        self.update_file_record_after_path_change(
            path_lookup_candidates_for_values(&[
                log.path_after.as_str(),
                log.target_path.as_str(),
                log.source_path.as_str(),
            ]),
            &log.path_before,
            &log.name_before,
        )
    }

    fn update_file_record_after_path_change(
        &self,
        lookup_candidates: Vec<String>,
        target_path: &str,
        new_name: &str,
    ) -> Result<bool, DbError> {
        let target = PathBuf::from(target_path);
        let metadata = fs::metadata(&target)?;
        let normalized_target = normalize_path_for_db(&target);
        let name = resolved_file_name(target_path, new_name);
        let extension = extension_from_file_name(&name);
        let size = if metadata.is_file() {
            i64::try_from(metadata.len()).unwrap_or(i64::MAX)
        } else {
            0
        };
        let mtime = metadata
            .modified()
            .ok()
            .and_then(system_time_to_unix_seconds)
            .unwrap_or_else(current_unix_seconds);
        let is_dir = metadata.is_dir();
        let target_candidates = path_lookup_candidates(target_path, &normalized_target);

        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let current_id = find_file_row_id(&tx, &lookup_candidates)?;
        let Some(current_id) = current_id else {
            tx.commit()?;
            return Ok(false);
        };

        for candidate in target_candidates {
            tx.execute(
                r#"
                DELETE FROM files
                WHERE (id = ?1 OR path = ?1)
                  AND id <> ?2
                "#,
                params![candidate, current_id],
            )?;
        }

        let updated = tx.execute(
            r#"
            UPDATE files
            SET id = ?1,
                path = ?1,
                name = ?2,
                extension = ?3,
                size = ?4,
                mtime = ?5,
                is_dir = ?6,
                suggested_action = 'Keep',
                requires_confirmation = 0,
                is_stale = 0,
                last_seen_at = ?7
            WHERE id = ?8
            "#,
            params![
                normalized_target,
                name,
                extension,
                size,
                mtime,
                bool_to_i64(is_dir),
                current_unix_seconds(),
                current_id
            ],
        )?;

        tx.commit()?;
        Ok(updated > 0)
    }

    pub fn execute_rules_on_inbox(
        &self,
        rules: Vec<Rule>,
    ) -> Result<RuleExecutionSummary, DbError> {
        let all_rules = active_rules(rules);
        let rule_version = rule_version_for_rules(&all_rules)?;
        let read_conn = self.conn()?;
        let mut write_conn = self.conn()?;
        let mut stmt = read_conn.prepare(
            r#"
                SELECT id, path, name, extension, size, mtime, ctime, is_dir, state_code,
                       file_type, purpose, lifecycle, context, risk_level, suggested_action,
                       suggested_target_path, suggested_name, confidence, classification_reason,
                       matched_rules, requires_confirmation, is_stale, last_seen_at,
                       last_classified_at, classified_rule_version, last_classified_mtime,
                       last_classified_size
                FROM files
                WHERE lifecycle = 'Inbox'
                  AND is_stale = 0
                ORDER BY mtime DESC, name COLLATE NOCASE ASC
                "#,
        )?;
        let mut rows = stmt.query([])?;

        let mut scanned = 0_i64;
        let mut updated = 0_i64;
        let mut skipped = 0_i64;
        let mut needs_confirmation = 0_i64;
        let mut batch = Vec::with_capacity(CLASSIFY_BATCH_SIZE);

        while let Some(row) = rows.next()? {
            let row = indexed_file_from_row(row)?;
            scanned += 1;
            if !should_classify_file(&row, &rule_version) {
                skipped += 1;
                continue;
            }

            batch.push(row);

            if batch.len() == CLASSIFY_BATCH_SIZE {
                let batch_summary = execute_classification_batch(
                    &mut write_conn,
                    &batch,
                    &all_rules,
                    &rule_version,
                )?;
                updated += batch_summary.updated;
                needs_confirmation += batch_summary.needs_confirmation;
                batch.clear();
            }
        }

        if !batch.is_empty() {
            let batch_summary =
                execute_classification_batch(&mut write_conn, &batch, &all_rules, &rule_version)?;
            updated += batch_summary.updated;
            needs_confirmation += batch_summary.needs_confirmation;
        }

        Ok(RuleExecutionSummary {
            scanned,
            updated,
            skipped,
            needs_confirmation,
        })
    }

    pub fn execute_rules_for_paths(
        &self,
        paths: &[String],
        rules: Vec<Rule>,
    ) -> Result<RuleExecutionSummary, DbError> {
        let target_paths = classification_path_candidates(paths, 500);
        if target_paths.is_empty() {
            return Ok(RuleExecutionSummary {
                scanned: 0,
                updated: 0,
                skipped: 0,
                needs_confirmation: 0,
            });
        }

        let all_rules = active_rules(rules);
        let rule_version = rule_version_for_rules(&all_rules)?;
        let placeholders = std::iter::repeat("?")
            .take(target_paths.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
            r#"
            SELECT id, path, name, extension, size, mtime, ctime, is_dir, state_code,
                   file_type, purpose, lifecycle, context, risk_level, suggested_action,
                   suggested_target_path, suggested_name, confidence, classification_reason,
                   matched_rules, requires_confirmation, is_stale, last_seen_at,
                   last_classified_at, classified_rule_version, last_classified_mtime,
                   last_classified_size
            FROM files
            WHERE lifecycle = 'Inbox'
              AND is_stale = 0
              AND path IN ({placeholders})
            ORDER BY mtime DESC, name COLLATE NOCASE ASC
            "#
        );
        let read_conn = self.conn()?;
        let mut write_conn = self.conn()?;
        let mut stmt = read_conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(target_paths.iter()), indexed_file_from_row)?;

        let mut scanned = 0_i64;
        let mut updated = 0_i64;
        let mut skipped = 0_i64;
        let mut needs_confirmation = 0_i64;
        let mut batch = Vec::with_capacity(CLASSIFY_BATCH_SIZE);

        for row in rows {
            let row = row?;
            scanned += 1;
            if !should_classify_file(&row, &rule_version) {
                skipped += 1;
                continue;
            }

            batch.push(row);

            if batch.len() == CLASSIFY_BATCH_SIZE {
                let batch_summary = execute_classification_batch(
                    &mut write_conn,
                    &batch,
                    &all_rules,
                    &rule_version,
                )?;
                updated += batch_summary.updated;
                needs_confirmation += batch_summary.needs_confirmation;
                batch.clear();
            }
        }

        if !batch.is_empty() {
            let batch_summary =
                execute_classification_batch(&mut write_conn, &batch, &all_rules, &rule_version)?;
            updated += batch_summary.updated;
            needs_confirmation += batch_summary.needs_confirmation;
        }

        Ok(RuleExecutionSummary {
            scanned,
            updated,
            skipped,
            needs_confirmation,
        })
    }

    pub fn search_files(
        &self,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Vec<FileSearchResult>, DbError> {
        let Some(fts_query) = build_fts_query(query) else {
            return Ok(Vec::new());
        };

        let limit = i64::from(limit.unwrap_or(50).clamp(1, 200));
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT
                f.id,
                f.path,
                f.name,
                f.extension,
                f.size,
                f.mtime,
                f.is_dir,
                f.state_code,
                bm25(files_fts, 6.0, 1.5) AS rank
            FROM files_fts
            JOIN files AS f ON f.rowid = files_fts.rowid
            WHERE files_fts MATCH ?1
              AND f.is_stale = 0
            ORDER BY rank ASC, f.mtime DESC, length(f.path) ASC
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(params![fts_query, limit], |row| {
            Ok(FileSearchResult {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                extension: row.get(3)?,
                size: row.get(4)?,
                mtime: row.get(5)?,
                is_dir: row.get::<_, i64>(6)? != 0,
                state_code: row.get(7)?,
                rank: row.get(8)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    pub fn get_paged_files(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
        query: Option<&str>,
    ) -> Result<PagedFilesResult, DbError> {
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let offset = offset.unwrap_or(0);
        let now = current_timestamp_iso();
        let conn = self.conn()?;

        if let Some(fts_query) = query.and_then(build_fts_query) {
            let total = conn.query_row(
                r#"
                SELECT COUNT(*)
                FROM files_fts
                JOIN files AS f ON f.rowid = files_fts.rowid
                WHERE files_fts MATCH ?1
                  AND f.is_stale = 0
                "#,
                params![fts_query],
                |row| row.get(0),
            )?;
            let mut stmt = conn.prepare(
                r#"
                SELECT
                    f.id,
                    f.path,
                    f.name,
                    f.extension,
                    f.size,
                    f.mtime,
                    f.ctime,
                    f.is_dir,
                    f.state_code,
                    f.file_type,
                    f.purpose,
                    f.lifecycle,
                    f.context,
                    f.risk_level,
                    f.suggested_action,
                    f.suggested_target_path,
                    f.suggested_name,
                    f.confidence,
                    f.classification_reason,
                    f.matched_rules,
                    f.requires_confirmation,
                    f.is_stale,
                    f.last_seen_at,
                    f.last_classified_at,
                    f.classified_rule_version,
                    f.last_classified_mtime,
                    f.last_classified_size,
                    bm25(files_fts, 6.0, 1.5) AS rank
                FROM files_fts
                JOIN files AS f ON f.rowid = files_fts.rowid
                WHERE files_fts MATCH ?1
                  AND f.is_stale = 0
                ORDER BY rank ASC, f.mtime DESC, length(f.path) ASC
                LIMIT ?2 OFFSET ?3
                "#,
            )?;
            let rows = stmt.query_map(
                params![fts_query, i64::from(limit), i64::from(offset)],
                indexed_file_from_row,
            )?;
            let files = rows
                .map(|row| row.map(|file| file_record_from_indexed(file, &now)))
                .collect::<Result<Vec<_>, _>>()?;

            return Ok(PagedFilesResult {
                files,
                total,
                limit,
                offset,
            });
        }

        let total = conn.query_row("SELECT COUNT(*) FROM files WHERE is_stale = 0", [], |row| {
            row.get(0)
        })?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, path, name, extension, size, mtime, ctime, is_dir, state_code,
                   file_type, purpose, lifecycle, context, risk_level, suggested_action,
                   suggested_target_path, suggested_name, confidence, classification_reason,
                   matched_rules, requires_confirmation, is_stale, last_seen_at,
                   last_classified_at, classified_rule_version, last_classified_mtime,
                   last_classified_size
            FROM files
            WHERE is_stale = 0
            ORDER BY mtime DESC, name COLLATE NOCASE ASC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;
        let rows = stmt.query_map(params![i64::from(limit), i64::from(offset)], |row| {
            indexed_file_from_row(row)
        })?;
        let files = rows
            .map(|row| row.map(|file| file_record_from_indexed(file, &now)))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PagedFilesResult {
            files,
            total,
            limit,
            offset,
        })
    }

    pub fn get_stats_summary(&self) -> Result<StatsSummary, DbError> {
        let conn = self.conn()?;
        // 一次事务内完成所有聚合，保证快照一致性
        conn.execute_batch("BEGIN DEFERRED")?;
        let (
            total_files,
            total_size,
            large_files,
            sensitive_files,
            needs_confirmation,
            last_mtime,
        ): (i64, i64, i64, i64, i64, Option<i64>) = conn.query_row(
            r#"
            SELECT
                COUNT(*)        FILTER (WHERE is_dir = 0),
                COALESCE(SUM(size) FILTER (WHERE is_dir = 0), 0),
                COUNT(*)        FILTER (WHERE is_dir = 0 AND size >= 104857600),
                COUNT(*)        FILTER (WHERE is_dir = 0
                                  AND (risk_level = 'Sensitive' OR lifecycle = 'Sensitive')),
                COUNT(*)        FILTER (WHERE is_dir = 0 AND requires_confirmation = 1),
                MAX(mtime)
            FROM files
            WHERE is_stale = 0
            "#,
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            },
        )?;
        let mut by_type = HashMap::new();
        let mut stmt = conn.prepare(
            r#"
            SELECT file_type, extension, is_dir, COUNT(*)
            FROM files
            WHERE is_stale = 0
            GROUP BY file_type, extension, is_dir
            "#,
        )?;
        let type_rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for row in type_rows {
            let (file_type, extension, is_dir, count) = row?;
            let normalized_type = if file_type.is_empty() || file_type == "Other" {
                infer_file_type(&extension, is_dir).to_string()
            } else {
                file_type
            };
            *by_type.entry(normalized_type).or_insert(0) += count;
        }
        drop(stmt);
        let mut by_lifecycle = HashMap::new();
        let mut stmt = conn.prepare(
            r#"
            SELECT lifecycle, COUNT(*)
            FROM files
            WHERE is_dir = 0
              AND is_stale = 0
            GROUP BY lifecycle
            "#,
        )?;
        let lifecycle_rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in lifecycle_rows {
            let (lifecycle, count) = row?;
            by_lifecycle.insert(lifecycle, count);
        }
        drop(stmt);
        conn.execute_batch("COMMIT")?;
        let disks = Disks::new_with_refreshed_list();
        let (disk_total, disk_free) = disks
            .iter()
            .map(|d| (d.total_space(), d.available_space()))
            .max_by_key(|(total, _)| *total)
            .unwrap_or((0, 0));
        let disk_usage_ratio = if disk_total > 0 {
            1.0 - (disk_free as f64 / disk_total as f64)
        } else {
            0.0
        };

        Ok(StatsSummary {
            total_files,
            total_size,
            disk_total_size: disk_total as i64,
            disk_free_size: disk_free as i64,
            disk_usage_ratio,
            duplicate_files: 0,
            large_files,
            sensitive_files,
            needs_confirmation,
            by_type,
            by_lifecycle,
            last_scanned_at: last_mtime.map(unix_seconds_to_iso),
        })
    }

    pub fn get_operation_logs(&self, limit: Option<u32>) -> Result<Vec<OperationLogDto>, DbError> {
        let limit = i64::from(limit.unwrap_or(500).clamp(1, 1000));
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id,
                batch_id,
                operation_type,
                source_path,
                target_path,
                old_name,
                new_name,
                status,
                error_message,
                created_at,
                can_undo,
                path_before,
                path_after,
                name_before,
                name_after,
                can_restore,
                restored_at,
                restore_status,
                restore_error
            FROM operation_logs
            ORDER BY created_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map(params![limit], operation_log_from_row)?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    pub fn get_user_rules(&self) -> Result<Vec<Rule>, DbError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id,
                name,
                source,
                enabled,
                priority,
                weight,
                root_operator,
                groups_json,
                action_json,
                created_at,
                updated_at
            FROM rules
            WHERE source = 'user'
            ORDER BY priority DESC, updated_at DESC, name COLLATE NOCASE ASC
            "#,
        )?;
        let rows = stmt.query_map([], rule_from_row)?;
        let mut rules = Vec::new();
        for row in rows {
            rules.push(rule_from_sql_row(row?)?);
        }

        Ok(rules)
    }

    pub fn save_user_rule(&self, rule: Rule) -> Result<Rule, DbError> {
        let mut rule = rule;
        rule.source = "user".to_string();
        let now = current_timestamp_iso();
        if rule.created_at.trim().is_empty() {
            rule.created_at =
                existing_rule_created_at(self, &rule.id)?.unwrap_or_else(|| now.clone());
        }
        if rule.updated_at.trim().is_empty() {
            rule.updated_at = now;
        }
        let groups_json = serde_json::to_string(&rule.groups)?;
        let action_json = serde_json::to_string(&rule.action)?;
        let rule_id = rule.id.clone();
        let conn = self.conn()?;
        conn.execute(
            r#"
            INSERT INTO rules (
                id,
                name,
                source,
                enabled,
                priority,
                weight,
                root_operator,
                groups_json,
                action_json,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                source = 'user',
                enabled = excluded.enabled,
                priority = excluded.priority,
                weight = excluded.weight,
                root_operator = excluded.root_operator,
                groups_json = excluded.groups_json,
                action_json = excluded.action_json,
                updated_at = excluded.updated_at
            "#,
            params![
                rule.id,
                rule.name,
                bool_to_i64(rule.enabled),
                rule.priority,
                rule.weight,
                rule.root_operator,
                groups_json,
                action_json,
                rule.created_at,
                rule.updated_at
            ],
        )?;

        get_user_rule_by_id(self, &rule_id)
    }

    pub fn delete_user_rule(&self, id: &str) -> Result<bool, DbError> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(false);
        }

        let conn = self.conn()?;
        let deleted = conn.execute(
            "DELETE FROM rules WHERE id = ?1 AND source = 'user'",
            params![id],
        )?;
        Ok(deleted > 0)
    }

    pub fn save_operation_logs(
        &self,
        batch_id: &str,
        logs: &[OperationLogDto],
    ) -> Result<(), DbError> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let created_at = logs
            .first()
            .map(|log| parse_operation_timestamp(&log.created_at))
            .unwrap_or_else(current_timestamp_ms);
        let batch_status = if logs.iter().any(|log| log.status == "failed") {
            "partial_failed"
        } else {
            "success"
        };

        tx.execute(
            r#"
            INSERT INTO operation_batches (id, created_at, status)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET
                created_at = excluded.created_at,
                status = excluded.status
            "#,
            params![batch_id, created_at, batch_status],
        )?;

        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO operation_logs (
                    id,
                    batch_id,
                    operation_type,
                    source_path,
                    target_path,
                    old_name,
                    new_name,
                    status,
                    error_message,
                    created_at,
                    can_undo,
                    path_before,
                    path_after,
                    name_before,
                    name_after,
                    can_restore,
                    restored_at,
                    restore_status,
                    restore_error
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
                ON CONFLICT(id) DO UPDATE SET
                    batch_id = excluded.batch_id,
                    operation_type = excluded.operation_type,
                    source_path = excluded.source_path,
                    target_path = excluded.target_path,
                    old_name = excluded.old_name,
                    new_name = excluded.new_name,
                    status = excluded.status,
                    error_message = excluded.error_message,
                    created_at = excluded.created_at,
                    can_undo = excluded.can_undo,
                    path_before = excluded.path_before,
                    path_after = excluded.path_after,
                    name_before = excluded.name_before,
                    name_after = excluded.name_after,
                    can_restore = excluded.can_restore,
                    restored_at = excluded.restored_at,
                    restore_status = excluded.restore_status,
                    restore_error = excluded.restore_error
                "#,
            )?;

            for log in logs {
                stmt.execute(params![
                    log.id,
                    log.batch_id,
                    log.operation_type,
                    log.source_path,
                    log.target_path,
                    log.old_name,
                    log.new_name,
                    log.status,
                    log.error_message,
                    parse_operation_timestamp(&log.created_at),
                    bool_to_i64(log.can_undo),
                    log.path_before,
                    log.path_after,
                    log.name_before,
                    log.name_after,
                    bool_to_i64(log.can_restore),
                    log.restored_at
                        .as_deref()
                        .and_then(parse_optional_operation_timestamp),
                    log.restore_status,
                    log.restore_error
                ])?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn update_operation_restore_logs(&self, logs: &[OperationLogDto]) -> Result<(), DbError> {
        if logs.is_empty() {
            return Ok(());
        }

        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
                UPDATE operation_logs
                SET can_restore = ?2,
                    restored_at = ?3,
                    restore_status = ?4,
                    restore_error = ?5,
                    can_undo = ?6
                WHERE id = ?1
                "#,
            )?;

            for log in logs {
                stmt.execute(params![
                    log.id,
                    bool_to_i64(log.can_restore),
                    log.restored_at
                        .as_deref()
                        .and_then(parse_optional_operation_timestamp),
                    log.restore_status,
                    log.restore_error,
                    bool_to_i64(log.can_undo)
                ])?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn prune_operation_logs(&self, retention_days: i64) -> Result<(), DbError> {
        let retention_days = retention_days.max(0);
        let retention_ms = retention_days.saturating_mul(24 * 60 * 60 * 1000);
        let prune_before = current_timestamp_ms().saturating_sub(retention_ms);
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;

        tx.execute(
            "DELETE FROM operation_logs WHERE created_at < ?1",
            params![prune_before],
        )?;
        tx.execute(
            r#"
            DELETE FROM operation_batches
            WHERE NOT EXISTS (
                SELECT 1
                FROM operation_logs
                WHERE operation_logs.batch_id = operation_batches.id
            )
            "#,
            [],
        )?;

        tx.commit()?;
        Ok(())
    }

    pub(crate) fn conn(&self) -> Result<PooledConnection<SqliteConnectionManager>, DbError> {
        self.pool.get().map_err(DbError::from)
    }
}

#[tauri::command]
pub fn init_db(db: State<'_, Database>) -> Result<(), String> {
    db.init().map_err(command_error)
}

#[tauri::command]
pub fn insert_file(db: State<'_, Database>, file: InsertFileRequest) -> Result<(), String> {
    db.insert_file(file).map_err(command_error)
}

#[tauri::command]
pub fn remove_files_by_paths(db: State<'_, Database>, paths: Vec<String>) -> Result<usize, String> {
    db.remove_files_by_paths(&paths).map_err(command_error)
}

#[tauri::command]
pub fn upsert_files_by_paths<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    paths: Vec<String>,
) -> Result<usize, String> {
    let db = db.inner();
    let upserted = upsert_files_by_paths_for_db(db, &paths).map_err(command_error)?;
    if let Some(report) = optimize_search_index_after_bulk_upsert(db, upserted) {
        emit_search_index_optimized(&app, &report);
    }
    Ok(upserted)
}

#[tauri::command]
pub fn search_files(
    db: State<'_, Database>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<FileSearchResult>, String> {
    db.search_files(&query, limit).map_err(command_error)
}

#[tauri::command]
pub fn get_paged_files(
    db: State<'_, Database>,
    limit: Option<u32>,
    offset: Option<u32>,
    query: Option<String>,
) -> Result<PagedFilesResult, String> {
    db.get_paged_files(limit, offset, query.as_deref())
        .map_err(command_error)
}

#[tauri::command]
pub fn get_stats_summary(db: State<'_, Database>) -> Result<StatsSummary, String> {
    db.get_stats_summary().map_err(command_error)
}

#[tauri::command]
pub fn get_operation_logs(
    db: State<'_, Database>,
    limit: Option<u32>,
) -> Result<Vec<OperationLogDto>, String> {
    db.get_operation_logs(limit).map_err(command_error)
}

#[tauri::command]
pub fn get_user_rules(db: State<'_, Database>) -> Result<Vec<Rule>, String> {
    db.get_user_rules().map_err(command_error)
}

#[tauri::command]
pub fn save_user_rule(db: State<'_, Database>, rule: Rule) -> Result<Rule, String> {
    db.save_user_rule(rule).map_err(command_error)
}

#[tauri::command]
pub fn delete_user_rule(db: State<'_, Database>, id: String) -> Result<bool, String> {
    db.delete_user_rule(&id).map_err(command_error)
}

#[tauri::command]
pub async fn execute_rules_on_inbox(
    db: State<'_, Database>,
    rules: Vec<Rule>,
) -> Result<RuleExecutionSummary, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.execute_rules_on_inbox(rules))
        .await
        .map_err(|error| error.to_string())?
        .map_err(command_error)
}

#[tauri::command]
pub async fn execute_rules_for_paths(
    db: State<'_, Database>,
    paths: Vec<String>,
    rules: Vec<Rule>,
) -> Result<RuleExecutionSummary, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.execute_rules_for_paths(&paths, rules))
        .await
        .map_err(|error| error.to_string())?
        .map_err(command_error)
}

fn configure_connection(conn: &mut Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        "#,
    )?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    conn.busy_timeout(std::time::Duration::from_secs(5))?;
    Ok(())
}

static FTS5_CHECKED: OnceLock<()> = OnceLock::new();

fn assert_fts5_available(conn: &Connection) -> Result<(), DbError> {
    if FTS5_CHECKED.get().is_none() {
        conn.execute_batch(
            r#"
            CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(value, tokenize='trigram');
            DROP TABLE temp.fts5_probe;
            "#,
        )?;
        let _ = FTS5_CHECKED.set(());
    }
    Ok(())
}

fn schema_version(conn: &Connection) -> Result<i32, DbError> {
    conn.query_row("SELECT user_version FROM pragma_user_version", [], |row| {
        row.get(0)
    })
    .map_err(DbError::from)
}

fn set_schema_version(conn: &Connection, version: i32) -> Result<(), DbError> {
    // PRAGMA user_version 不支持参数绑定，用格式化字符串（整数无 SQL 注入风险）
    conn.execute_batch(&format!("PRAGMA user_version = {version}"))
        .map_err(DbError::from)
}

fn migrate(conn: &Connection) -> Result<(), DbError> {
    assert_fts5_available(conn)?;
    let version = schema_version(conn)?;
    if version >= CURRENT_SCHEMA_VERSION {
        return Ok(());
    }
    if version < 1 {
        // 建表 + 基础索引
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS files (
                id TEXT PRIMARY KEY,
                path TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                extension TEXT NOT NULL DEFAULT '',
                size INTEGER NOT NULL DEFAULT 0,
                mtime INTEGER NOT NULL DEFAULT 0,
                is_dir INTEGER NOT NULL DEFAULT 0 CHECK (is_dir IN (0, 1)),
                state_code INTEGER NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
            CREATE INDEX IF NOT EXISTS idx_files_name ON files(name);
            CREATE INDEX IF NOT EXISTS idx_files_extension ON files(extension);
            CREATE INDEX IF NOT EXISTS idx_files_mtime ON files(mtime DESC);
            "#,
        )?;
        set_schema_version(conn, 1)?;
    }
    if version < 2 {
        // 分类字段 + FTS + 触发器
        execute_column_migrations(
            conn,
            &[
                "ALTER TABLE files ADD COLUMN file_type TEXT NOT NULL DEFAULT 'Other';",
                "ALTER TABLE files ADD COLUMN purpose TEXT NOT NULL DEFAULT 'Unknown';",
                "ALTER TABLE files ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'Inbox';",
                "ALTER TABLE files ADD COLUMN context TEXT NOT NULL DEFAULT '';",
                "ALTER TABLE files ADD COLUMN risk_level TEXT NOT NULL DEFAULT 'Normal';",
                "ALTER TABLE files ADD COLUMN suggested_action TEXT NOT NULL DEFAULT 'Keep';",
                "ALTER TABLE files ADD COLUMN suggested_target_path TEXT NOT NULL DEFAULT '';",
                "ALTER TABLE files ADD COLUMN suggested_name TEXT NOT NULL DEFAULT '';",
                "ALTER TABLE files ADD COLUMN confidence REAL NOT NULL DEFAULT 0.5;",
                "ALTER TABLE files ADD COLUMN classification_reason TEXT NOT NULL DEFAULT 'Indexed by Zen Canvas Tauri backend.';",
                "ALTER TABLE files ADD COLUMN matched_rules TEXT NOT NULL DEFAULT '[]';",
                "ALTER TABLE files ADD COLUMN requires_confirmation INTEGER NOT NULL DEFAULT 0;",
            ],
        )?;
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_files_file_type ON files(file_type);
            CREATE INDEX IF NOT EXISTS idx_files_purpose ON files(purpose);
            CREATE INDEX IF NOT EXISTS idx_files_lifecycle ON files(lifecycle);
            CREATE INDEX IF NOT EXISTS idx_files_risk_level ON files(risk_level);
            CREATE INDEX IF NOT EXISTS idx_files_requires_confirmation ON files(requires_confirmation);
            "#,
        )?;
        ensure_trigram_fts(conn)?;
        conn.execute_batch(
            r#"
            CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
                INSERT INTO files_fts(rowid, name, path) VALUES (new.rowid, new.name, new.path);
            END;
            CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name, path)
                VALUES('delete', old.rowid, old.name, old.path);
            END;
            CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
                INSERT INTO files_fts(files_fts, rowid, name, path)
                VALUES('delete', old.rowid, old.name, old.path);
                INSERT INTO files_fts(rowid, name, path) VALUES (new.rowid, new.name, new.path);
            END;
            "#,
        )?;
        set_schema_version(conn, 2)?;
    }
    if version < 3 {
        // 新增 ctime 字段（真实创建时间）
        execute_column_migrations(
            conn,
            &["ALTER TABLE files ADD COLUMN ctime INTEGER NOT NULL DEFAULT 0;"],
        )?;
        set_schema_version(conn, 3)?;
    }
    if version < 4 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS operation_batches (
                id TEXT PRIMARY KEY,
                created_at INTEGER NOT NULL,
                status TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS operation_logs (
                id TEXT PRIMARY KEY,
                batch_id TEXT NOT NULL,
                operation_type TEXT NOT NULL,
                source_path TEXT NOT NULL,
                target_path TEXT NOT NULL,
                old_name TEXT NOT NULL,
                new_name TEXT NOT NULL,
                status TEXT NOT NULL,
                error_message TEXT,
                created_at INTEGER NOT NULL,
                can_undo INTEGER NOT NULL DEFAULT 0,
                path_before TEXT NOT NULL,
                path_after TEXT NOT NULL,
                name_before TEXT NOT NULL,
                name_after TEXT NOT NULL,
                can_restore INTEGER NOT NULL DEFAULT 0,
                restored_at INTEGER,
                restore_status TEXT NOT NULL DEFAULT 'not_restored',
                restore_error TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_operation_logs_batch_id ON operation_logs(batch_id);
            CREATE INDEX IF NOT EXISTS idx_operation_logs_created_at ON operation_logs(created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_operation_logs_restore_status ON operation_logs(restore_status);
            "#,
        )?;
        set_schema_version(conn, 4)?;
    }
    if version < 5 {
        execute_column_migrations(
            conn,
            &[
                "ALTER TABLE files ADD COLUMN is_stale INTEGER NOT NULL DEFAULT 0;",
                "ALTER TABLE files ADD COLUMN last_seen_at INTEGER NOT NULL DEFAULT 0;",
            ],
        )?;
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_files_is_stale ON files(is_stale);
            CREATE INDEX IF NOT EXISTS idx_files_last_seen_at ON files(last_seen_at DESC);
            "#,
        )?;
        set_schema_version(conn, 5)?;
    }
    if version < 6 {
        execute_column_migrations(
            conn,
            &[
                "ALTER TABLE files ADD COLUMN last_classified_at INTEGER NOT NULL DEFAULT 0;",
                "ALTER TABLE files ADD COLUMN classified_rule_version TEXT NOT NULL DEFAULT '';",
                "ALTER TABLE files ADD COLUMN last_classified_mtime INTEGER NOT NULL DEFAULT 0;",
                "ALTER TABLE files ADD COLUMN last_classified_size INTEGER NOT NULL DEFAULT 0;",
            ],
        )?;
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_files_classified_version ON files(classified_rule_version);
            CREATE INDEX IF NOT EXISTS idx_files_last_classified_at ON files(last_classified_at DESC);
            CREATE INDEX IF NOT EXISTS idx_files_classification_fingerprint ON files(last_classified_mtime, last_classified_size);
            "#,
        )?;
        set_schema_version(conn, 6)?;
    }
    if version < 7 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS rules (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'user',
                enabled INTEGER NOT NULL DEFAULT 1,
                priority REAL NOT NULL DEFAULT 0,
                weight REAL NOT NULL DEFAULT 0,
                root_operator TEXT NOT NULL DEFAULT 'AND',
                groups_json TEXT NOT NULL DEFAULT '[]',
                action_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_rules_source ON rules(source);
            CREATE INDEX IF NOT EXISTS idx_rules_enabled ON rules(enabled);
            CREATE INDEX IF NOT EXISTS idx_rules_priority ON rules(priority DESC);
            "#,
        )?;
        set_schema_version(conn, 7)?;
    }
    if version < 8 {
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS app_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )?;
        conn.execute(
            r#"
            INSERT OR IGNORE INTO app_settings (key, value)
            VALUES (?1, ?2)
            "#,
            params![
                crate::settings::APP_SETTINGS_KEY,
                crate::settings::default_settings_json()?
            ],
        )?;
        set_schema_version(conn, 8)?;
    }
    Ok(())
}

fn execute_column_migrations(conn: &Connection, statements: &[&str]) -> Result<(), DbError> {
    for statement in statements {
        match conn.execute_batch(statement) {
            Ok(()) => {}
            Err(rusqlite::Error::SqliteFailure(_, Some(message)))
                if message.contains("duplicate column name") => {}
            Err(error) => return Err(DbError::Sqlite(error)),
        }
    }
    Ok(())
}

fn ensure_trigram_fts(conn: &Connection) -> Result<(), DbError> {
    let existing_sql = conn
        .query_row(
            "SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'files_fts'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    if existing_sql
        .as_deref()
        .map(is_trigram_fts_definition)
        .unwrap_or(false)
    {
        return Ok(());
    }

    conn.execute_batch(
        r#"
        DROP TRIGGER IF EXISTS files_ai;
        DROP TRIGGER IF EXISTS files_ad;
        DROP TRIGGER IF EXISTS files_au;
        DROP TABLE IF EXISTS files_fts;

        CREATE VIRTUAL TABLE files_fts USING fts5(
            name,
            path,
            content='files',
            content_rowid='rowid',
            tokenize='trigram'
        );

        INSERT INTO files_fts(files_fts) VALUES('rebuild');
        "#,
    )?;
    Ok(())
}

fn is_trigram_fts_definition(sql: &str) -> bool {
    let normalized = sql.to_ascii_lowercase().replace(char::is_whitespace, "");
    normalized.contains("tokenize='trigram'") || normalized.contains("tokenize=\"trigram\"")
}

fn trim_trailing_path_separators(path: &str) -> &str {
    let mut end = path.len();
    while end > 1 {
        let current = &path[..end];
        if !(current.ends_with('\\') || current.ends_with('/')) {
            break;
        }
        if end == 3 && current.as_bytes().get(1) == Some(&b':') {
            break;
        }
        end -= 1;
    }
    &path[..end]
}

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '~' | '%' | '_') {
            escaped.push('~');
        }
        escaped.push(ch);
    }
    escaped
}

fn build_fts_query(input: &str) -> Option<String> {
    let phrases = input
        .split_whitespace()
        .filter(|phrase| !phrase.is_empty())
        .take(12)
        .map(quote_fts_phrase)
        .collect::<Vec<_>>();

    if phrases.is_empty() {
        None
    } else {
        Some(phrases.join(" AND "))
    }
}

fn quote_fts_phrase(phrase: &str) -> String {
    format!("\"{}\"", phrase.replace('"', "\"\""))
}

fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

fn active_rules(rules: Vec<Rule>) -> Vec<Rule> {
    built_in_rules()
        .into_iter()
        .chain(rules.into_iter().filter(|rule| rule.enabled))
        .collect()
}

fn rule_version_for_rules(rules: &[Rule]) -> Result<String, DbError> {
    let mut stable_rules = rules.to_vec();
    stable_rules.sort_by(|left, right| {
        left.priority
            .partial_cmp(&right.priority)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.source.cmp(&right.source))
    });
    let payload = serde_json::to_string(&stable_rules)?;
    let digest = Sha256::digest(payload.as_bytes());
    Ok(digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

fn should_classify_file(row: &IndexedFileRow, rule_version: &str) -> bool {
    row.last_classified_at == 0
        || row.classified_rule_version != rule_version
        || row.last_classified_mtime != row.mtime
        || row.last_classified_size != row.size
}

fn classification_path_candidates(paths: &[String], limit: usize) -> Vec<String> {
    let mut candidates = Vec::new();
    for path in paths
        .iter()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        let path = trim_trailing_path_separators(path);
        if path.is_empty() {
            continue;
        }
        let normalized_path = normalize_path_text(path);
        for candidate in path_lookup_candidates(path, &normalized_path) {
            push_unique(&mut candidates, candidate);
            if candidates.len() >= limit {
                return candidates;
            }
        }
    }
    candidates
}

fn path_lookup_candidates(first: &str, second: &str) -> Vec<String> {
    path_lookup_candidates_for_values(&[first, second])
}

fn path_lookup_candidates_for_values(values: &[&str]) -> Vec<String> {
    let mut candidates = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        push_unique(&mut candidates, trimmed.to_string());
        push_unique(&mut candidates, normalize_path_text(trimmed));
    }
    candidates
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn normalize_path_for_db(path: &Path) -> String {
    normalize_path_text(&path.to_string_lossy())
}

fn normalize_path_text(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if let Some(stripped) = normalized.strip_prefix("//?/UNC/") {
        return format!("//{stripped}");
    }
    if let Some(stripped) = normalized.strip_prefix("//?/") {
        return stripped.to_string();
    }
    normalized
}

fn resolved_file_name(target_path: &str, new_name: &str) -> String {
    let trimmed = new_name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }

    target_path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(target_path)
        .to_string()
}

fn extension_from_file_name(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn find_file_row_id(conn: &Connection, candidates: &[String]) -> Result<Option<String>, DbError> {
    for candidate in candidates {
        let found = conn
            .query_row(
                "SELECT id FROM files WHERE id = ?1 OR path = ?1 LIMIT 1",
                params![candidate],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn system_time_to_unix_seconds(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
}

fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

fn parse_operation_timestamp(value: &str) -> i64 {
    value
        .parse::<i64>()
        .unwrap_or_else(|_| current_timestamp_ms())
}

fn parse_optional_operation_timestamp(value: &str) -> Option<i64> {
    value.parse::<i64>().ok()
}

fn command_error(error: DbError) -> String {
    error.to_string()
}

pub fn upsert_files_by_paths_for_db(db: &Database, paths: &[String]) -> Result<usize, DbError> {
    let mut files = Vec::new();
    let mut seen = Vec::new();

    for raw_path in paths
        .iter()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        let path = trim_trailing_path_separators(raw_path);
        if path.is_empty() {
            continue;
        }

        let path_buf = PathBuf::from(path);
        let metadata = match fs::metadata(&path_buf) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(DbError::Io(error)),
        };
        let normalized_path = normalize_path_for_db(&path_buf);
        if seen.iter().any(|value| value == &normalized_path) {
            continue;
        }
        push_unique(&mut seen, normalized_path.clone());

        files.push(insert_request_from_metadata(
            normalized_path,
            &path_buf,
            &metadata,
        ));
    }

    let upserted = files.len();
    if upserted > 0 {
        db.insert_files(&files)?;
    }
    Ok(upserted)
}

fn upsert_files_by_paths_with_optional_optimize(
    db: &Database,
    paths: &[String],
) -> Result<usize, DbError> {
    let upserted = upsert_files_by_paths_for_db(db, paths)?;
    let _ = optimize_search_index_after_bulk_upsert(db, upserted);
    Ok(upserted)
}

fn optimize_search_index_after_bulk_upsert(
    db: &Database,
    upserted: usize,
) -> Option<SearchIndexOptimizeReport> {
    if upserted >= OPTIMIZE_AFTER_UPSERT_THRESHOLD {
        Some(run_search_index_optimize("watcher_bulk_upsert", db))
    } else {
        None
    }
}

pub fn run_search_index_optimize(trigger: &str, db: &Database) -> SearchIndexOptimizeReport {
    let started = Instant::now();
    match db.optimize_search_index() {
        Ok(duration_ms) => SearchIndexOptimizeReport {
            trigger: trigger.to_string(),
            duration_ms,
            success: true,
            error: None,
        },
        Err(error) => {
            let message = error.to_string();
            eprintln!("SQLite/FTS optimize failed for {trigger}: {message}");
            SearchIndexOptimizeReport {
                trigger: trigger.to_string(),
                duration_ms: started.elapsed().as_millis(),
                success: false,
                error: Some(message),
            }
        }
    }
}

pub fn emit_search_index_optimized<R: Runtime>(
    app: &AppHandle<R>,
    report: &SearchIndexOptimizeReport,
) {
    if let Err(error) = app.emit(SEARCH_INDEX_OPTIMIZED_EVENT, report) {
        eprintln!(
            "Failed to emit {SEARCH_INDEX_OPTIMIZED_EVENT} event for {}: {error}",
            report.trigger
        );
    }
}

fn insert_request_from_metadata(
    normalized_path: String,
    path: &Path,
    metadata: &fs::Metadata,
) -> InsertFileRequest {
    let is_dir = metadata.is_dir();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| resolved_file_name(&normalized_path, ""));
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let size = if metadata.is_file() {
        i64::try_from(metadata.len()).unwrap_or(i64::MAX)
    } else {
        0
    };
    let mtime = metadata
        .modified()
        .ok()
        .and_then(system_time_to_unix_seconds)
        .unwrap_or_else(current_unix_seconds);
    let ctime = metadata
        .created()
        .ok()
        .and_then(system_time_to_unix_seconds)
        .unwrap_or(mtime);

    InsertFileRequest {
        id: normalized_path.clone(),
        path: normalized_path,
        name,
        extension,
        size,
        mtime,
        ctime,
        is_dir,
        state_code: 0,
    }
}

fn indexed_file_from_row(row: &Row<'_>) -> rusqlite::Result<IndexedFileRow> {
    Ok(IndexedFileRow {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        extension: row.get(3)?,
        size: row.get(4)?,
        mtime: row.get(5)?,
        ctime: row.get(6)?,
        is_dir: row.get::<_, i64>(7)? != 0,
        state_code: row.get(8)?,
        file_type: row.get(9)?,
        purpose: row.get(10)?,
        lifecycle: row.get(11)?,
        context: row.get(12)?,
        risk_level: row.get(13)?,
        suggested_action: row.get(14)?,
        suggested_target_path: row.get(15)?,
        suggested_name: row.get(16)?,
        confidence: row.get(17)?,
        classification_reason: row.get(18)?,
        matched_rules: row.get(19)?,
        requires_confirmation: row.get::<_, i64>(20)? != 0,
        is_stale: row.get::<_, i64>(21)? != 0,
        last_seen_at: row.get(22)?,
        last_classified_at: row.get(23)?,
        classified_rule_version: row.get(24)?,
        last_classified_mtime: row.get(25)?,
        last_classified_size: row.get(26)?,
    })
}

fn operation_log_from_row(row: &Row<'_>) -> rusqlite::Result<OperationLogDto> {
    let created_at: i64 = row.get(9)?;
    let restored_at: Option<i64> = row.get(16)?;
    Ok(OperationLogDto {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        operation_type: row.get(2)?,
        source_path: row.get(3)?,
        target_path: row.get(4)?,
        old_name: row.get(5)?,
        new_name: row.get(6)?,
        status: row.get(7)?,
        error_message: row.get(8)?,
        created_at: created_at.to_string(),
        can_undo: row.get::<_, i64>(10)? != 0,
        path_before: row.get(11)?,
        path_after: row.get(12)?,
        name_before: row.get(13)?,
        name_after: row.get(14)?,
        can_restore: row.get::<_, i64>(15)? != 0,
        restored_at: restored_at.map(|value| value.to_string()),
        restore_status: row.get(17)?,
        restore_error: row.get(18)?,
    })
}

struct RuleSqlRow {
    id: String,
    name: String,
    source: String,
    enabled: bool,
    priority: f64,
    weight: f64,
    root_operator: String,
    groups_json: String,
    action_json: String,
    created_at: String,
    updated_at: String,
}

fn rule_from_row(row: &Row<'_>) -> rusqlite::Result<RuleSqlRow> {
    Ok(RuleSqlRow {
        id: row.get(0)?,
        name: row.get(1)?,
        source: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
        priority: row.get(4)?,
        weight: row.get(5)?,
        root_operator: row.get(6)?,
        groups_json: row.get(7)?,
        action_json: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn rule_from_sql_row(row: RuleSqlRow) -> Result<Rule, DbError> {
    Ok(Rule {
        id: row.id,
        name: row.name,
        source: row.source,
        enabled: row.enabled,
        priority: row.priority,
        weight: row.weight,
        root_operator: row.root_operator,
        groups: serde_json::from_str::<Vec<RuleConditionGroup>>(&row.groups_json)?,
        action: serde_json::from_str::<RuleAction>(&row.action_json)?,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn existing_rule_created_at(db: &Database, id: &str) -> Result<Option<String>, DbError> {
    let conn = db.conn()?;
    conn.query_row(
        "SELECT created_at FROM rules WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(DbError::from)
}

fn get_user_rule_by_id(db: &Database, id: &str) -> Result<Rule, DbError> {
    let conn = db.conn()?;
    let row = conn.query_row(
        r#"
        SELECT
            id,
            name,
            source,
            enabled,
            priority,
            weight,
            root_operator,
            groups_json,
            action_json,
            created_at,
            updated_at
        FROM rules
        WHERE id = ?1
          AND source = 'user'
        "#,
        params![id],
        rule_from_row,
    )?;
    rule_from_sql_row(row)
}

fn file_record_from_indexed(row: IndexedFileRow, now: &str) -> FileRecordDto {
    let created_at = unix_seconds_to_iso(if row.ctime == 0 { row.mtime } else { row.ctime });
    let modified_at = unix_seconds_to_iso(row.mtime);
    let last_seen_at = unix_seconds_to_iso(if row.last_seen_at == 0 {
        row.mtime
    } else {
        row.last_seen_at
    });
    let file_type = normalized_file_type(&row);
    let matched_rules = serde_json::from_str::<Vec<String>>(&row.matched_rules).unwrap_or_default();

    FileRecordDto {
        id: row.id,
        name: row.name.clone(),
        path: row.path.clone(),
        directory: parent_directory(&row.path),
        extension: row.extension,
        size: row.size,
        file_type,
        purpose: row.purpose,
        lifecycle: row.lifecycle,
        context: row.context,
        risk_level: row.risk_level,
        hash: None,
        created_at,
        modified_at,
        scanned_at: now.to_string(),
        last_seen_at,
        is_hidden: row.name.starts_with('.'),
        is_deleted: false,
        is_duplicate: false,
        suggested_action: row.suggested_action,
        suggested_target_path: row.suggested_target_path,
        suggested_name: if row.suggested_name.is_empty() {
            row.name
        } else {
            row.suggested_name
        },
        confidence: row.confidence,
        classification_reason: row.classification_reason,
        matched_rules,
        requires_confirmation: row.requires_confirmation,
        last_opened_at: None,
        open_count: 0,
        indexed_at: now.to_string(),
        source_id: None,
        is_stale: row.is_stale,
        state_code: row.state_code,
    }
}

#[derive(Debug, Clone)]
struct RuleCandidate {
    rule: Rule,
    score: f64,
}

#[derive(Debug, Clone)]
struct BuiltinClassification {
    action: RuleAction,
    confidence: f64,
}

#[derive(Debug, Clone)]
struct ClassificationUpdate {
    file_type: String,
    purpose: String,
    lifecycle: String,
    context: String,
    risk_level: String,
    suggested_action: String,
    suggested_target_path: String,
    suggested_name: String,
    confidence: f64,
    classification_reason: String,
    matched_rules: String,
    requires_confirmation: bool,
}

fn execute_classification_batch(
    conn: &mut Connection,
    batch: &[IndexedFileRow],
    all_rules: &[Rule],
    rule_version: &str,
) -> Result<RuleExecutionSummary, DbError> {
    let mut updated = 0_i64;
    let mut needs_confirmation = 0_i64;
    let classified_at = current_unix_seconds();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            r#"
                UPDATE files
                SET file_type = ?2,
                    purpose = ?3,
                    lifecycle = ?4,
                    context = ?5,
                    risk_level = ?6,
                    suggested_action = ?7,
                    suggested_target_path = ?8,
                    suggested_name = ?9,
                    confidence = ?10,
                    classification_reason = ?11,
                    matched_rules = ?12,
                    requires_confirmation = ?13,
                    last_classified_at = ?14,
                    classified_rule_version = ?15,
                    last_classified_mtime = ?16,
                    last_classified_size = ?17
                WHERE id = ?1
                "#,
        )?;

        for row in batch {
            let classification = classify_indexed_file(row, all_rules)?;
            if classification.requires_confirmation {
                needs_confirmation += 1;
            }
            stmt.execute(params![
                row.id,
                classification.file_type,
                classification.purpose,
                classification.lifecycle,
                classification.context,
                classification.risk_level,
                classification.suggested_action,
                classification.suggested_target_path,
                classification.suggested_name,
                classification.confidence,
                classification.classification_reason,
                classification.matched_rules,
                bool_to_i64(classification.requires_confirmation),
                classified_at,
                rule_version,
                row.mtime,
                row.size
            ])?;
            updated += 1;
        }
    }
    tx.commit()?;

    Ok(RuleExecutionSummary {
        scanned: batch.len() as i64,
        updated,
        skipped: 0,
        needs_confirmation,
    })
}

fn classify_indexed_file(
    row: &IndexedFileRow,
    all_rules: &[Rule],
) -> Result<ClassificationUpdate, DbError> {
    let file_type = normalized_file_type(row);
    let builtin = classify_builtin(row, &file_type);
    let mut candidates = all_rules
        .iter()
        .filter_map(|rule| {
            let matches = evaluate_rule(rule, row, &file_type);
            matches.then(|| RuleCandidate {
                score: rule.weight + rule.priority * 0.1,
                rule: rule.clone(),
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                right
                    .rule
                    .priority
                    .partial_cmp(&left.rule.priority)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let top = candidates.first();
    let runner_up = candidates.get(1);
    let has_conflict = top
        .zip(runner_up)
        .map(|(top, runner_up)| top.score - runner_up.score <= 10.0)
        .unwrap_or(false);
    let action = top
        .map(|candidate| merge_action(&builtin.action, &candidate.rule.action))
        .unwrap_or_else(|| builtin.action.clone());
    let matched_rule_names = candidates
        .iter()
        .map(|candidate| candidate.rule.name.clone())
        .collect::<Vec<_>>();
    let confidence = top
        .map(|candidate| (candidate.score / 100.0).clamp(0.35, 0.98))
        .unwrap_or(builtin.confidence);
    let risk_level = action
        .risk_level
        .clone()
        .unwrap_or_else(|| default_if_empty(&row.risk_level, "Unknown"));
    let suggested_action = safe_action(
        &action
            .suggested_action
            .clone()
            .unwrap_or_else(|| default_if_empty(&row.suggested_action, "Keep")),
        &risk_level,
    );
    let suggested_target_path =
        build_target_path(row, &file_type, action.target_template.as_deref());
    let suggested_name = build_suggested_name(row, action.rename_template.as_deref());
    let requires_confirmation = risk_level == "Sensitive"
        || has_conflict
        || confidence < 0.65
        || suggested_action == "Review"
        || suggested_action == "DeleteCandidate";

    Ok(ClassificationUpdate {
        file_type,
        purpose: action
            .purpose
            .clone()
            .unwrap_or_else(|| default_if_empty(&row.purpose, "Unknown")),
        lifecycle: action
            .lifecycle
            .clone()
            .unwrap_or_else(|| default_if_empty(&row.lifecycle, "Inbox")),
        context: action
            .context
            .clone()
            .unwrap_or_else(|| row.context.clone()),
        risk_level: risk_level.clone(),
        suggested_action,
        suggested_target_path,
        suggested_name,
        confidence,
        classification_reason: build_classification_reason(
            &matched_rule_names,
            has_conflict,
            &risk_level,
        ),
        matched_rules: serde_json::to_string(&matched_rule_names)?,
        requires_confirmation,
    })
}

fn built_in_rules() -> Vec<Rule> {
    vec![
        system_rule(
            "system_identity",
            "Sensitive identity documents",
            100.0,
            95.0,
            "OR",
            vec![
                condition("name", "contains", "passport"),
                condition("name", "contains", "visa"),
                condition("name", "contains", "身份证"),
                condition("name", "contains", "护照"),
                condition("path", "contains", "identity"),
            ],
            RuleAction {
                purpose: Some("Identity".to_string()),
                lifecycle: Some("Sensitive".to_string()),
                risk_level: Some("Sensitive".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Personal/Identity".to_string()),
                context: Some("Identity".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_career",
            "Career and resume files",
            90.0,
            84.0,
            "OR",
            vec![
                condition("name", "contains", "resume"),
                condition("name", "contains", "cv"),
                condition("name", "contains", "cover letter"),
                condition("path", "contains", "career"),
            ],
            RuleAction {
                purpose: Some("Career".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Career".to_string()),
                context: Some("Career".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_finance",
            "Finance and receipt files",
            80.0,
            80.0,
            "OR",
            vec![
                condition("name", "contains", "invoice"),
                condition("name", "contains", "receipt"),
                condition("name", "contains", "tax"),
                condition("path", "contains", "bank"),
            ],
            RuleAction {
                purpose: Some("Finance".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Sensitive".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Finance".to_string()),
                context: Some("Finance".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_study",
            "Study material and coursework",
            70.0,
            70.0,
            "OR",
            vec![
                condition("name", "contains", "assignment"),
                condition("name", "contains", "lecture"),
                condition("name", "contains", "paper"),
                condition("name", "contains", "comp"),
            ],
            RuleAction {
                purpose: Some("Study".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Study".to_string()),
                context: Some("Study".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_installer",
            "Installers and setup packages",
            60.0,
            68.0,
            "OR",
            vec![
                condition("file_type", "equals", "Installer"),
                condition("name", "contains", "setup"),
                condition("name", "contains", "installer"),
            ],
            RuleAction {
                purpose: Some("Installer".to_string()),
                lifecycle: Some("Disposable".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("90_Temporary/Installers".to_string()),
                context: Some("Installer".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_project_folder",
            "Project folder boundary",
            55.0,
            86.0,
            "OR",
            vec![condition("extension", "equals", "folder")],
            RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                context: Some("Project Folder".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_inbox_downloads",
            "Downloads and desktop inbox",
            50.0,
            62.0,
            "OR",
            vec![
                condition("directory", "contains", "downloads"),
                condition("directory", "contains", "desktop"),
            ],
            RuleAction {
                purpose: Some("Temporary".to_string()),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("00_Inbox".to_string()),
                context: Some("Inbox".to_string()),
                ..RuleAction::default()
            },
        ),
    ]
}

fn classify_builtin(row: &IndexedFileRow, file_type: &str) -> BuiltinClassification {
    let haystack = format!("{} {}", row.name, row.path).to_lowercase();
    let age_days = days_since_unix(row.mtime);

    if row.is_dir {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                context: Some("Project Folder".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.86,
        };
    }

    if any_contains(
        &haystack,
        &[
            "passport",
            "visa",
            "id",
            "identity",
            "private",
            "身份证",
            "护照",
            "银行卡",
        ],
    ) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Identity".to_string()),
                lifecycle: Some("Sensitive".to_string()),
                risk_level: Some("Sensitive".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Personal/Identity".to_string()),
                context: Some("Identity".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.92,
        };
    }

    if any_contains(
        &haystack,
        &["resume", "cv", "cover letter", "portfolio", "interview"],
    ) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Career".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Career".to_string()),
                context: Some("Career".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.84,
        };
    }

    if any_contains(
        &haystack,
        &[
            "invoice", "receipt", "bill", "tax", "payment", "bank", "paypal",
        ],
    ) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Finance".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Sensitive".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Finance".to_string()),
                context: Some("Finance".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.78,
        };
    }

    if any_contains(
        &haystack,
        &[
            "course",
            "lecture",
            "assignment",
            "report",
            "paper",
            "comp",
            "math",
            "cs",
        ],
    ) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Study".to_string()),
                lifecycle: Some(if age_days <= 30 { "Active" } else { "Archive" }.to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some(
                    if age_days <= 30 {
                        "20_Areas/Study"
                    } else {
                        "40_Archive/{year}/Study"
                    }
                    .to_string(),
                ),
                context: Some(extract_study_context(&row.name)),
                ..RuleAction::default()
            },
            confidence: 0.72,
        };
    }

    if file_type == "Installer" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Installer".to_string()),
                lifecycle: Some("Disposable".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("90_Temporary/Installers".to_string()),
                context: Some("Installer".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.68,
        };
    }

    if any_contains(
        &haystack,
        &["temp", "tmp", "copy", "副本", "screenshot", "screen shot"],
    ) || is_inbox_directory(&parent_directory(&row.path))
    {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some(
                    if file_type == "Image" {
                        "Media"
                    } else {
                        "Temporary"
                    }
                    .to_string(),
                ),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some(
                    if file_type == "Image" {
                        "Rename"
                    } else {
                        "Move"
                    }
                    .to_string(),
                ),
                target_template: Some("00_Inbox".to_string()),
                rename_template: (file_type == "Image").then(|| "{basename}_{date}".to_string()),
                context: Some("Inbox".to_string()),
            },
            confidence: 0.62,
        };
    }

    BuiltinClassification {
        action: RuleAction {
            purpose: Some("Unknown".to_string()),
            lifecycle: Some(
                if age_days <= 14 {
                    "Active"
                } else {
                    "Reference"
                }
                .to_string(),
            ),
            risk_level: Some("Unknown".to_string()),
            suggested_action: Some("Keep".to_string()),
            target_template: Some(String::new()),
            context: Some(String::new()),
            ..RuleAction::default()
        },
        confidence: 0.45,
    }
}

fn evaluate_rule(rule: &Rule, row: &IndexedFileRow, file_type: &str) -> bool {
    if !rule.enabled || rule.groups.is_empty() {
        return false;
    }
    let results = rule
        .groups
        .iter()
        .map(|group| evaluate_group(group, row, file_type))
        .collect::<Vec<_>>();
    if rule.root_operator.eq_ignore_ascii_case("AND") {
        results.iter().all(|value| *value)
    } else {
        results.iter().any(|value| *value)
    }
}

fn evaluate_group(group: &RuleConditionGroup, row: &IndexedFileRow, file_type: &str) -> bool {
    if group.conditions.is_empty() {
        return false;
    }
    let results = group
        .conditions
        .iter()
        .map(|condition| evaluate_condition(condition, row, file_type))
        .collect::<Vec<_>>();
    if group.operator.eq_ignore_ascii_case("OR") {
        results.iter().any(|value| *value)
    } else {
        results.iter().all(|value| *value)
    }
}

fn evaluate_condition(condition: &RuleCondition, row: &IndexedFileRow, file_type: &str) -> bool {
    let raw = condition_value(&condition.field, row, file_type).to_lowercase();
    let expected = json_value_to_string(&condition.value).to_lowercase();
    match condition.operator.as_str() {
        "contains" => raw.contains(&expected),
        "equals" | "is" => raw == expected,
        "startsWith" => raw.starts_with(&expected),
        "endsWith" => raw.ends_with(&expected),
        "greaterThan" => raw.parse::<f64>().unwrap_or(0.0) > json_value_to_f64(&condition.value),
        "lessThan" => raw.parse::<f64>().unwrap_or(0.0) < json_value_to_f64(&condition.value),
        "olderThanDays" => days_since_unix(row.mtime) > json_value_to_i64(&condition.value),
        "newerThanDays" => days_since_unix(row.mtime) < json_value_to_i64(&condition.value),
        _ => false,
    }
}

fn condition_value(field: &str, row: &IndexedFileRow, file_type: &str) -> String {
    match field {
        "name" => row.name.clone(),
        "extension" => {
            if row.is_dir {
                "folder".to_string()
            } else {
                row.extension.clone()
            }
        }
        "file_type" => file_type.to_string(),
        "path" => row.path.clone(),
        "directory" => parent_directory(&row.path),
        "size" => row.size.to_string(),
        "modified_at" => unix_seconds_to_iso(row.mtime),
        "is_duplicate" => "false".to_string(),
        "risk_level" => row.risk_level.clone(),
        _ => String::new(),
    }
}

fn merge_action(base: &RuleAction, override_action: &RuleAction) -> RuleAction {
    RuleAction {
        purpose: override_action
            .purpose
            .clone()
            .or_else(|| base.purpose.clone()),
        lifecycle: override_action
            .lifecycle
            .clone()
            .or_else(|| base.lifecycle.clone()),
        context: override_action
            .context
            .clone()
            .or_else(|| base.context.clone()),
        risk_level: override_action
            .risk_level
            .clone()
            .or_else(|| base.risk_level.clone()),
        suggested_action: override_action
            .suggested_action
            .clone()
            .or_else(|| base.suggested_action.clone()),
        target_template: override_action
            .target_template
            .clone()
            .or_else(|| base.target_template.clone()),
        rename_template: override_action
            .rename_template
            .clone()
            .or_else(|| base.rename_template.clone()),
    }
}

fn build_classification_reason(
    matched_rules: &[String],
    has_conflict: bool,
    risk_level: &str,
) -> String {
    let mut parts = if matched_rules.is_empty() {
        vec!["No strong rule matched".to_string()]
    } else {
        vec![format!(
            "Matched {}",
            matched_rules
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )]
    };
    if has_conflict {
        parts.push("similar rule scores require review".to_string());
    }
    if risk_level == "Sensitive" {
        parts.push("sensitive files require manual confirmation".to_string());
    }
    parts.join("; ")
}

fn build_target_path(row: &IndexedFileRow, file_type: &str, template: Option<&str>) -> String {
    let Some(template) = template.filter(|value| !value.is_empty()) else {
        return String::new();
    };
    let year = unix_seconds_to_iso(row.mtime)
        .get(0..4)
        .unwrap_or("1970")
        .to_string();
    let resolved = template
        .replace("{year}", &year)
        .replace("{type}", file_type);
    let mut target = PathBuf::from(parent_directory(&row.path));
    target.push("ZenCanvas");
    for segment in resolved
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
    {
        target.push(segment);
    }
    target.to_string_lossy().to_string()
}

fn build_suggested_name(row: &IndexedFileRow, template: Option<&str>) -> String {
    let Some(template) = template.filter(|value| !value.is_empty()) else {
        return row.name.clone();
    };
    let basename = clean_name(file_stem(&row.name, &row.extension));
    let date = unix_seconds_to_iso(row.mtime)
        .get(0..10)
        .unwrap_or("1970-01-01")
        .replace('-', "");
    let extension = row.extension.trim_start_matches('.');
    let suffix = if extension.is_empty() {
        String::new()
    } else {
        format!(".{extension}")
    };
    format!(
        "{}{}",
        template
            .replace("{basename}", &basename)
            .replace("{date}", &date)
            .replace("{extension}", extension),
        suffix
    )
}

fn file_stem<'a>(name: &'a str, extension: &str) -> &'a str {
    let extension = extension.trim_start_matches('.');
    if extension.is_empty() {
        return name;
    }
    let suffix = format!(".{extension}");
    if name.to_lowercase().ends_with(&suffix.to_lowercase()) && name.len() > suffix.len() {
        &name[..name.len() - suffix.len()]
    } else {
        name
    }
}

fn clean_name(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_separator = false;
    for character in value.trim().chars() {
        if character.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&character) {
            output.extend(character.to_lowercase());
            last_was_separator = false;
        } else if !last_was_separator {
            output.push('_');
            last_was_separator = true;
        }
    }
    output.trim_matches('_').to_string()
}

fn safe_action(action: &str, risk_level: &str) -> String {
    if (risk_level == "Sensitive" && action != "Keep") || action == "DeleteCandidate" {
        "Review".to_string()
    } else {
        action.to_string()
    }
}

fn normalized_file_type(row: &IndexedFileRow) -> String {
    if row.file_type.is_empty() || row.file_type == "Other" {
        infer_file_type(&row.extension, row.is_dir).to_string()
    } else {
        row.file_type.clone()
    }
}

fn default_if_empty(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn any_contains(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn is_inbox_directory(directory: &str) -> bool {
    let normalized = directory.to_lowercase();
    normalized.contains("downloads") || normalized.contains("desktop")
}

fn extract_study_context(name: &str) -> String {
    name.split(|character: char| !character.is_ascii_alphanumeric())
        .find(|part| {
            let has_letters = part
                .chars()
                .any(|character| character.is_ascii_alphabetic());
            let has_digits = part.chars().any(|character| character.is_ascii_digit());
            (4..=10).contains(&part.len()) && has_letters && has_digits
        })
        .map(|part| part.to_ascii_uppercase())
        .unwrap_or_else(|| "Study".to_string())
}

fn days_since_unix(mtime: i64) -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(mtime);
    ((now - mtime).max(0)) / 86_400
}

fn json_value_to_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn json_value_to_f64(value: &Value) -> f64 {
    match value {
        Value::Number(value) => value.as_f64().unwrap_or(0.0),
        Value::String(value) => value.parse().unwrap_or(0.0),
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        _ => 0.0,
    }
}

fn json_value_to_i64(value: &Value) -> i64 {
    json_value_to_f64(value) as i64
}

fn system_rule(
    id: &str,
    name: &str,
    priority: f64,
    weight: f64,
    group_operator: &str,
    conditions: Vec<RuleCondition>,
    action: RuleAction,
) -> Rule {
    Rule {
        id: id.to_string(),
        name: name.to_string(),
        source: "system".to_string(),
        enabled: true,
        priority,
        weight,
        root_operator: "OR".to_string(),
        groups: vec![RuleConditionGroup {
            id: format!("{id}_group"),
            operator: group_operator.to_string(),
            conditions,
        }],
        action,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn condition(field: &str, operator: &str, value: &str) -> RuleCondition {
    RuleCondition {
        id: format!("{field}_{operator}_{value}"),
        field: field.to_string(),
        operator: operator.to_string(),
        value: Value::String(value.to_string()),
    }
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

fn parent_directory(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

fn infer_file_type(extension: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "Other";
    }

    match extension.to_ascii_lowercase().as_str() {
        "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" => "Document",
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "svg" => "Image",
        "mp4" | "mov" | "mkv" | "avi" | "webm" => "Video",
        "mp3" | "wav" | "flac" | "aac" | "m4a" => "Audio",
        "zip" | "rar" | "7z" | "tar" | "gz" => "ArchivePackage",
        "exe" | "msi" | "dmg" | "pkg" | "appimage" => "Installer",
        "xls" | "xlsx" | "csv" | "numbers" => "Spreadsheet",
        "ppt" | "pptx" | "key" => "Presentation",
        "js" | "jsx" | "ts" | "tsx" | "rs" | "go" | "py" | "java" | "kt" | "swift" | "c"
        | "cpp" | "h" | "hpp" | "cs" | "php" | "rb" | "html" | "css" | "scss" | "json" | "yaml"
        | "yml" | "toml" => "Code",
        _ => "Other",
    }
}

fn unix_seconds_to_iso(seconds: i64) -> String {
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|time| time.format(&Rfc3339).ok())
        .unwrap_or_else(current_timestamp_iso)
}

fn current_timestamp_iso() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|time| time.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn get_paged_files_returns_limit_and_offset() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-1", "report.pdf", "pdf", 2_048, 1_800_000_000);
        insert_test_file(&db, "file-2", "photo.jpg", "jpg", 4_096, 1_900_000_000);

        let page = db.get_paged_files(Some(1), Some(1), None).expect("page");

        assert_eq!(page.total, 2);
        assert_eq!(page.limit, 1);
        assert_eq!(page.offset, 1);
        assert_eq!(page.files.len(), 1);
        assert_eq!(page.files[0].name, "report.pdf");
    }

    #[test]
    fn get_stats_summary_aggregates_files_and_types() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-1", "report.pdf", "pdf", 2_048, 1_800_000_000);
        insert_test_file(&db, "file-2", "photo.jpg", "jpg", 4_096, 1_900_000_000);

        let stats = db.get_stats_summary().expect("stats");

        assert_eq!(stats.total_files, 2);
        assert_eq!(stats.total_size, 6_144);
        assert_eq!(stats.by_type.get("Document"), Some(&1));
        assert_eq!(stats.by_type.get("Image"), Some(&1));
        assert_eq!(stats.by_lifecycle.get("Inbox"), Some(&2));
    }

    #[test]
    fn remove_files_by_paths_marks_file_stale() {
        let db = Database::open(test_db_path()).expect("open test database");
        db.insert_file(InsertFileRequest {
            id: "dir-project".to_string(),
            path: "/test/virtual/documents/project".to_string(),
            name: "project".to_string(),
            extension: String::new(),
            size: 0,
            mtime: 1_900_000_000,
            ctime: 0,
            is_dir: true,
            state_code: 0,
        })
        .expect("insert project directory");
        db.insert_file(InsertFileRequest {
            id: "file-ghost".to_string(),
            path: "/test/virtual/documents/project/ghost-report.pdf".to_string(),
            name: "ghost-report.pdf".to_string(),
            extension: "pdf".to_string(),
            size: 2_048,
            mtime: 1_900_000_001,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert child file");
        db.insert_file(InsertFileRequest {
            id: "file-survivor".to_string(),
            path: "/test/virtual/documents/project-other/survivor.pdf".to_string(),
            name: "survivor.pdf".to_string(),
            extension: "pdf".to_string(),
            size: 2_048,
            mtime: 1_900_000_002,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert sibling file");

        let removed = db
            .remove_files_by_paths(&["/test/virtual/documents/project".to_string()])
            .expect("remove paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let ghost_search = db.search_files("ghost-report", Some(10)).expect("search");

        assert_eq!(removed, 2);
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].id, "file-survivor");
        assert!(ghost_search.is_empty());
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/project"),
            Some((true, true))
        );
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/project/ghost-report.pdf"),
            Some((true, true))
        );
    }

    #[test]
    fn insert_files_revives_stale_file() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-report",
            "report.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        db.remove_files_by_paths(&["/test/virtual/documents/report.pdf".to_string()])
            .expect("mark stale");
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/report.pdf"),
            Some((true, true))
        );

        insert_test_file(
            &db,
            "file-report",
            "report.pdf",
            "pdf",
            4_096,
            1_900_000_100,
        );
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].id, "file-report");
        assert_eq!(page.files[0].size, 4_096);
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/report.pdf"),
            Some((false, true))
        );
    }

    #[test]
    fn search_files_excludes_stale_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-report",
            "report.txt",
            "txt",
            2_048,
            1_900_000_000,
        );

        let before = db.search_files("report", Some(10)).expect("search before");
        db.remove_files_by_paths(&["/test/virtual/documents/report.txt".to_string()])
            .expect("mark stale");
        let after = db.search_files("report", Some(10)).expect("search after");

        assert_eq!(before.len(), 1);
        assert!(after.is_empty());
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/report.txt"),
            Some((true, true))
        );
    }

    #[test]
    fn optimize_search_index_returns_duration() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-report",
            "report.txt",
            "txt",
            2_048,
            1_900_000_000,
        );

        let duration_ms = db.optimize_search_index().expect("optimize search index");
        let results = db.search_files("report", Some(10)).expect("search");

        assert!(duration_ms <= 60_000);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "report.txt");
    }

    #[test]
    fn run_search_index_optimize_reports_success() {
        let db = Database::open(test_db_path()).expect("open test database");

        let report = run_search_index_optimize("scan_complete", &db);

        assert_eq!(report.trigger, "scan_complete");
        assert!(report.success);
        assert!(report.duration_ms <= 60_000);
        assert!(report.error.is_none());
    }

    #[test]
    fn stats_excludes_stale_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-report",
            "report.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let before = db.get_stats_summary().expect("stats before");
        db.remove_files_by_paths(&["/test/virtual/documents/report.pdf".to_string()])
            .expect("mark stale");
        let after = db.get_stats_summary().expect("stats after");

        assert_eq!(before.total_files, 1);
        assert_eq!(before.total_size, 2_048);
        assert_eq!(after.total_files, 0);
        assert_eq!(after.total_size, 0);
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/report.pdf"),
            Some((true, true))
        );
    }

    #[test]
    fn execute_rules_ignores_stale_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-stale",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        db.remove_files_by_paths(&["/test/virtual/documents/resume_2026.pdf".to_string()])
            .expect("mark stale");

        let summary = db
            .execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let row = file_classification(&db, "/test/virtual/documents/resume_2026.pdf")
            .expect("stale file still exists");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
        assert_eq!(row, ("Unknown".to_string(), "Inbox".to_string(), true));
    }

    #[test]
    fn execute_rules_for_paths_classifies_only_target_paths() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-target",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        insert_test_file(
            &db,
            "file-invoice-untouched",
            "invoice_apple.pdf",
            "pdf",
            2_048,
            1_900_000_001,
        );

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/resume_2026.pdf".to_string()],
                Vec::new(),
            )
            .expect("execute targeted rules");
        let target = file_classification(&db, "/test/virtual/documents/resume_2026.pdf")
            .expect("target file");
        let untouched = file_classification(&db, "/test/virtual/documents/invoice_apple.pdf")
            .expect("untouched file");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(
            target,
            ("Career".to_string(), "Reference".to_string(), false)
        );
        assert_eq!(
            untouched,
            ("Unknown".to_string(), "Inbox".to_string(), false)
        );
    }

    #[test]
    fn execute_rules_for_paths_ignores_missing_paths() {
        let db = Database::open(test_db_path()).expect("open test database");

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/missing.pdf".to_string()],
                Vec::new(),
            )
            .expect("execute targeted rules");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
        assert_eq!(summary.needs_confirmation, 0);
    }

    #[test]
    fn execute_rules_for_paths_ignores_stale_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-stale-target",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        db.remove_files_by_paths(&["/test/virtual/documents/resume_2026.pdf".to_string()])
            .expect("mark stale");

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/resume_2026.pdf".to_string()],
                Vec::new(),
            )
            .expect("execute targeted rules");
        let row = file_classification(&db, "/test/virtual/documents/resume_2026.pdf")
            .expect("stale file still exists");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
        assert_eq!(row, ("Unknown".to_string(), "Inbox".to_string(), true));
    }

    #[test]
    fn execute_rules_for_paths_ignores_non_inbox_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-archive",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        set_file_lifecycle(&db, "/test/virtual/documents/resume_2026.pdf", "Archive");

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/resume_2026.pdf".to_string()],
                Vec::new(),
            )
            .expect("execute targeted rules");
        let row = file_classification(&db, "/test/virtual/documents/resume_2026.pdf")
            .expect("archive file");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
        assert_eq!(row, ("Unknown".to_string(), "Archive".to_string(), false));
    }

    #[test]
    fn execute_rules_on_inbox_skips_unchanged_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-plain", "plain.tmp", "tmp", 2_048, 1_900_000_000);

        let first = db.execute_rules_on_inbox(Vec::new()).expect("first rules");
        let second = db.execute_rules_on_inbox(Vec::new()).expect("second rules");

        assert_eq!(first.scanned, 1);
        assert_eq!(first.updated, 1);
        assert_eq!(first.skipped, 0);
        assert_eq!(second.scanned, 1);
        assert_eq!(second.updated, 0);
        assert_eq!(second.skipped, 1);
    }

    #[test]
    fn execute_rules_on_inbox_reclassifies_when_rule_changes() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-special",
            "special_project.txt",
            "txt",
            2_048,
            1_900_000_000,
        );

        let first = db
            .execute_rules_on_inbox(vec![name_contains_rule(
                "special-rule-a",
                "Special A",
                "Project",
            )])
            .expect("first rules");
        let first_fingerprint =
            classification_fingerprint(&db, "/test/virtual/documents/special_project.txt")
                .expect("first fingerprint");
        let second = db
            .execute_rules_on_inbox(vec![name_contains_rule(
                "special-rule-b",
                "Special B",
                "Career",
            )])
            .expect("second rules");
        let second_fingerprint =
            classification_fingerprint(&db, "/test/virtual/documents/special_project.txt")
                .expect("second fingerprint");

        assert_eq!(first.updated, 1);
        assert_eq!(second.scanned, 1);
        assert_eq!(second.updated, 1);
        assert_eq!(second.skipped, 0);
        assert_ne!(first_fingerprint.1, second_fingerprint.1);
    }

    #[test]
    fn execute_rules_on_inbox_reclassifies_when_file_mtime_changes() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-plain", "plain.tmp", "tmp", 2_048, 1_900_000_000);

        db.execute_rules_on_inbox(Vec::new()).expect("first rules");
        set_file_mtime(&db, "/test/virtual/documents/plain.tmp", 1_900_000_100);
        let second = db.execute_rules_on_inbox(Vec::new()).expect("second rules");
        let fingerprint = classification_fingerprint(&db, "/test/virtual/documents/plain.tmp")
            .expect("fingerprint");

        assert_eq!(second.scanned, 1);
        assert_eq!(second.updated, 1);
        assert_eq!(second.skipped, 0);
        assert_eq!(fingerprint.2, 1_900_000_100);
    }

    #[test]
    fn execute_rules_on_inbox_reclassifies_when_file_size_changes() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-plain", "plain.tmp", "tmp", 2_048, 1_900_000_000);

        db.execute_rules_on_inbox(Vec::new()).expect("first rules");
        set_file_size(&db, "/test/virtual/documents/plain.tmp", 4_096);
        let second = db.execute_rules_on_inbox(Vec::new()).expect("second rules");
        let fingerprint = classification_fingerprint(&db, "/test/virtual/documents/plain.tmp")
            .expect("fingerprint");

        assert_eq!(second.scanned, 1);
        assert_eq!(second.updated, 1);
        assert_eq!(second.skipped, 0);
        assert_eq!(fingerprint.3, 4_096);
    }

    #[test]
    fn execute_rules_for_paths_sets_classification_fingerprint() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-target",
            "target.tmp",
            "tmp",
            4_096,
            1_900_000_000,
        );

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/target.tmp".to_string()],
                Vec::new(),
            )
            .expect("targeted rules");
        let fingerprint = classification_fingerprint(&db, "/test/virtual/documents/target.tmp")
            .expect("fingerprint");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(summary.skipped, 0);
        assert!(fingerprint.0 > 0);
        assert!(!fingerprint.1.is_empty());
        assert_eq!(fingerprint.2, 1_900_000_000);
        assert_eq!(fingerprint.3, 4_096);
    }

    #[test]
    fn rule_version_is_stable_for_same_rules() {
        let rules = vec![
            name_contains_rule("special-rule-a", "Special A", "Project"),
            name_contains_rule("special-rule-b", "Special B", "Career"),
        ];

        let first = rule_version_for_rules(&rules).expect("first version");
        let second = rule_version_for_rules(&rules).expect("second version");

        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn rule_version_ignores_user_rule_order() {
        let rule_a = name_contains_rule("special-rule-a", "Special A", "Project");
        let rule_b = name_contains_rule("special-rule-b", "Special B", "Career");

        let first =
            rule_version_for_rules(&[rule_a.clone(), rule_b.clone()]).expect("first version");
        let second = rule_version_for_rules(&[rule_b, rule_a]).expect("second version");

        assert_eq!(first, second);
    }

    #[test]
    fn rule_version_changes_when_rule_content_changes() {
        let mut changed_rule = name_contains_rule("special-rule-a", "Special A", "Project");
        let original = rule_version_for_rules(&[changed_rule.clone()]).expect("original version");

        changed_rule.weight = 50.0;
        let changed = rule_version_for_rules(&[changed_rule]).expect("changed version");

        assert_ne!(original, changed);
    }

    #[test]
    fn save_user_rule_round_trips_rule() {
        let db = Database::open(test_db_path()).expect("open test database");
        let rule = user_rule_for_persistence("rule-round-trip", "Round Trip", 300.0);

        let saved = db.save_user_rule(rule.clone()).expect("save user rule");
        let rules = db.get_user_rules().expect("get user rules");

        assert_eq!(saved.id, rule.id);
        assert_eq!(saved.source, "user");
        assert_eq!(rules.len(), 1);
        assert_rule_matches(&rules[0], &saved);
        assert_eq!(rules[0].groups.len(), 1);
        assert_eq!(rules[0].groups[0].operator, "AND");
        assert_eq!(rules[0].groups[0].conditions[0].field, "extension");
        assert_eq!(
            rules[0].groups[0].conditions[0].value,
            Value::String("pdf".to_string())
        );
        assert_eq!(rules[0].action.lifecycle.as_deref(), Some("Archive"));
        assert_eq!(
            rules[0].action.target_template.as_deref(),
            Some("{home}/Archive")
        );
    }

    #[test]
    fn save_user_rule_forces_source_user() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut rule = user_rule_for_persistence("rule-source", "Source", 200.0);
        rule.source = "system".to_string();

        let saved = db.save_user_rule(rule).expect("save user rule");
        let rules = db.get_user_rules().expect("get user rules");

        assert_eq!(saved.source, "user");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].source, "user");
    }

    #[test]
    fn save_user_rule_updates_existing_rule() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut rule = user_rule_for_persistence("rule-update", "Before", 100.0);
        db.save_user_rule(rule.clone()).expect("save initial rule");

        rule.name = "After".to_string();
        rule.enabled = false;
        rule.action.lifecycle = Some("TrashReview".to_string());
        let saved = db.save_user_rule(rule.clone()).expect("update rule");
        let rules = db.get_user_rules().expect("get user rules");

        assert_eq!(rules.len(), 1);
        assert_eq!(saved.name, "After");
        assert!(!rules[0].enabled);
        assert_eq!(rules[0].action.lifecycle.as_deref(), Some("TrashReview"));
    }

    #[test]
    fn get_user_rules_orders_by_priority() {
        let db = Database::open(test_db_path()).expect("open test database");
        db.save_user_rule(user_rule_for_persistence("rule-low", "Low", 10.0))
            .expect("save low rule");
        db.save_user_rule(user_rule_for_persistence("rule-high", "High", 900.0))
            .expect("save high rule");
        db.save_user_rule(user_rule_for_persistence("rule-mid", "Mid", 100.0))
            .expect("save mid rule");

        let rules = db.get_user_rules().expect("get user rules");
        let ids = rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["rule-high", "rule-mid", "rule-low"]);
    }

    #[test]
    fn delete_user_rule_removes_user_rule() {
        let db = Database::open(test_db_path()).expect("open test database");
        db.save_user_rule(user_rule_for_persistence("rule-delete", "Delete", 100.0))
            .expect("save user rule");

        let deleted = db
            .delete_user_rule("rule-delete")
            .expect("delete user rule");
        let rules = db.get_user_rules().expect("get user rules");

        assert!(deleted);
        assert!(rules.iter().all(|rule| rule.id != "rule-delete"));
    }

    #[test]
    fn delete_user_rule_ignores_missing_rule() {
        let db = Database::open(test_db_path()).expect("open test database");

        let deleted = db
            .delete_user_rule("missing-rule")
            .expect("delete missing rule");

        assert!(!deleted);
    }

    #[test]
    fn delete_user_rule_does_not_delete_non_user_rule() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_system_rule_row(&db, "system-rule");

        let deleted = db
            .delete_user_rule("system-rule")
            .expect("delete system rule");
        let source = rule_source_by_id(&db, "system-rule").expect("system rule row");

        assert!(!deleted);
        assert_eq!(source, "system");
    }

    #[test]
    fn upsert_files_by_paths_inserts_new_file() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let file = root.join("new-report.txt");
        fs::write(&file, "hello").expect("write file");

        let upserted = upsert_files_by_paths_for_db(&db, &[file.to_string_lossy().into_owned()])
            .expect("upsert paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(upserted, 1);
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].name, "new-report.txt");
        assert_eq!(page.files[0].path, normalized_test_path(&file));
        assert!(!page.files[0].is_stale);
    }

    #[test]
    fn upsert_files_by_paths_updates_modified_file() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let file = root.join("notes.txt");
        fs::write(&file, "old").expect("write file");
        let path = normalized_test_path(&file);
        db.insert_file(InsertFileRequest {
            id: path.clone(),
            path: path.clone(),
            name: "notes.txt".to_string(),
            extension: "txt".to_string(),
            size: 3,
            mtime: 1,
            ctime: 1,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert old file");
        fs::write(&file, "new content").expect("modify file");

        let upserted = upsert_files_by_paths_for_db(&db, &[file.to_string_lossy().into_owned()])
            .expect("upsert paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(upserted, 1);
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].size, 11);
        assert!(page.files[0].modified_at.len() > 0);
    }

    #[test]
    fn upsert_files_by_paths_revives_stale_file() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let file = root.join("revived.txt");
        fs::write(&file, "hello").expect("write file");
        let path = normalized_test_path(&file);
        db.insert_file(InsertFileRequest {
            id: path.clone(),
            path: path.clone(),
            name: "revived.txt".to_string(),
            extension: "txt".to_string(),
            size: 5,
            mtime: 1,
            ctime: 1,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert file");
        db.remove_files_by_paths(&[path.clone()])
            .expect("mark stale");

        let upserted = upsert_files_by_paths_for_db(&db, &[file.to_string_lossy().into_owned()])
            .expect("upsert paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(upserted, 1);
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].path, path);
        assert_eq!(stale_state(&db, &page.files[0].path), Some((false, true)));
    }

    #[test]
    fn upsert_files_by_paths_ignores_missing_path() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let missing = root.join("missing.txt");

        let upserted = upsert_files_by_paths_for_db(&db, &[missing.to_string_lossy().into_owned()])
            .expect("upsert paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(upserted, 0);
        assert_eq!(page.total, 0);
    }

    #[test]
    fn upsert_files_by_paths_with_optional_optimize_handles_large_batch() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let mut paths = Vec::with_capacity(OPTIMIZE_AFTER_UPSERT_THRESHOLD);
        for index in 0..OPTIMIZE_AFTER_UPSERT_THRESHOLD {
            let file = root.join(format!("large-upsert-{index:04}.txt"));
            fs::write(&file, format!("file {index}")).expect("write file");
            paths.push(file.to_string_lossy().into_owned());
        }

        let upserted =
            upsert_files_by_paths_with_optional_optimize(&db, &paths).expect("upsert paths");
        let page = db.get_paged_files(Some(1), Some(0), None).expect("page");

        assert_eq!(upserted, OPTIMIZE_AFTER_UPSERT_THRESHOLD);
        assert_eq!(page.total, OPTIMIZE_AFTER_UPSERT_THRESHOLD as i64);
    }

    #[test]
    fn execute_rules_updates_inbox_resume_classification() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let summary = db
            .execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let file = page
            .files
            .iter()
            .find(|file| file.id == "file-resume")
            .expect("classified file");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(file.purpose, "Career");
        assert_eq!(file.lifecycle, "Reference");
        assert_eq!(file.suggested_action, "Move");
        assert!(file.confidence >= 0.8);
        assert!(file
            .matched_rules
            .iter()
            .any(|rule| rule.contains("Career")));
        assert_ne!(
            file.classification_reason,
            "Indexed by Zen Canvas Tauri backend."
        );
    }

    #[test]
    fn execute_rules_marks_finance_files_sensitive_review_only() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-invoice",
            "invoice_apple.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let summary = db
            .execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let file = page
            .files
            .iter()
            .find(|file| file.id == "file-invoice")
            .expect("classified file");

        assert_eq!(summary.needs_confirmation, 1);
        assert_eq!(file.purpose, "Finance");
        assert_eq!(file.risk_level, "Sensitive");
        assert_eq!(file.suggested_action, "Review");
        assert!(file.requires_confirmation);
    }

    #[test]
    fn execute_rules_accepts_user_rules_that_override_builtins() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-project",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let user_rule = Rule {
            id: "user_resume_project".to_string(),
            name: "Resume project override".to_string(),
            source: "user".to_string(),
            enabled: true,
            priority: 150.0,
            weight: 96.0,
            root_operator: "OR".to_string(),
            groups: vec![RuleConditionGroup {
                id: "resume_project_group".to_string(),
                operator: "AND".to_string(),
                conditions: vec![RuleCondition {
                    id: "resume_name".to_string(),
                    field: "name".to_string(),
                    operator: "contains".to_string(),
                    value: Value::String("resume".to_string()),
                }],
            }],
            action: RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                context: Some("Override".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                rename_template: None,
            },
            created_at: String::new(),
            updated_at: String::new(),
        };

        db.execute_rules_on_inbox(vec![user_rule])
            .expect("execute rules");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let file = page
            .files
            .iter()
            .find(|file| file.id == "file-resume-project")
            .expect("classified file");

        assert_eq!(file.purpose, "Project");
        assert_eq!(file.lifecycle, "Active");
        assert!(file
            .matched_rules
            .iter()
            .any(|rule| rule == "Resume project override"));
    }

    #[test]
    fn search_files_matches_chinese_substrings_with_trigram() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-cn",
            "项目报告2026_final.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let results = db.search_files("报告2026", Some(10)).expect("search");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "项目报告2026_final.pdf");
    }

    #[test]
    fn operation_log_tables_exist_after_migration() {
        let db = Database::open(test_db_path()).expect("open test database");
        let conn = Connection::open(db.path()).expect("open migrated database");

        let table_count: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*)
                FROM sqlite_schema
                WHERE type = 'table'
                  AND name IN ('operation_batches', 'operation_logs')
                "#,
                [],
                |row| row.get(0),
            )
            .expect("count operation tables");

        assert_eq!(table_count, 2);
    }

    #[test]
    fn get_operation_logs_returns_empty_array_for_empty_table() {
        let db = Database::open(test_db_path()).expect("open test database");

        let logs = db.get_operation_logs(Some(500)).expect("operation logs");

        assert!(logs.is_empty());
    }

    #[test]
    fn save_operation_logs_persists_success_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let log = operation_log("log-success", "batch-success", "success");

        db.save_operation_logs("batch-success", &[log.clone()])
            .expect("save operation logs");
        let logs = db.get_operation_logs(Some(10)).expect("operation logs");

        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].id, log.id);
        assert_eq!(logs[0].batch_id, "batch-success");
        assert_eq!(logs[0].status, "success");
        assert!(logs[0].can_restore);
        assert_eq!(operation_batch_status(&db, "batch-success"), "success");
    }

    #[test]
    fn save_operation_logs_persists_failed_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-failed", "batch-failed", "failed");
        log.error_message = Some("Source file does not exist.".to_string());
        log.can_undo = false;
        log.can_restore = false;

        db.save_operation_logs("batch-failed", &[log.clone()])
            .expect("save operation logs");
        let logs = db.get_operation_logs(Some(10)).expect("operation logs");

        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].status, "failed");
        assert_eq!(
            logs[0].error_message.as_deref(),
            Some("Source file does not exist.")
        );
        assert!(!logs[0].can_restore);
        assert_eq!(
            operation_batch_status(&db, "batch-failed"),
            "partial_failed"
        );
    }

    #[test]
    fn save_operation_logs_persists_skipped_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-skipped", "batch-skipped", "skipped");
        log.error_message = Some("Operation is not executable.".to_string());
        log.can_undo = false;
        log.can_restore = false;

        db.save_operation_logs("batch-skipped", &[log.clone()])
            .expect("save operation logs");
        let logs = db.get_operation_logs(Some(10)).expect("operation logs");

        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].status, "skipped");
        assert_eq!(
            logs[0].error_message.as_deref(),
            Some("Operation is not executable.")
        );
        assert!(!logs[0].can_restore);
        assert_eq!(operation_batch_status(&db, "batch-skipped"), "success");
    }

    #[test]
    fn update_operation_restore_logs_marks_restored_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-restored", "batch-restored", "success");
        db.save_operation_logs("batch-restored", &[log.clone()])
            .expect("save operation logs");

        log.can_undo = false;
        log.can_restore = false;
        log.restored_at = Some("1900000000999".to_string());
        log.restore_status = "restored".to_string();
        log.restore_error = None;
        db.update_operation_restore_logs(&[log])
            .expect("update restore logs");

        let logs = db.get_operation_logs(Some(10)).expect("operation logs");
        assert_eq!(logs[0].restore_status, "restored");
        assert!(!logs[0].can_restore);
        assert!(!logs[0].can_undo);
        assert_eq!(logs[0].restored_at.as_deref(), Some("1900000000999"));
        assert!(logs[0].restore_error.is_none());
    }

    #[test]
    fn update_operation_restore_logs_marks_failed_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-restore-failed", "batch-restore-failed", "success");
        db.save_operation_logs("batch-restore-failed", &[log.clone()])
            .expect("save operation logs");

        log.restore_status = "failed".to_string();
        log.restore_error = Some("Target file already exists.".to_string());
        db.update_operation_restore_logs(&[log])
            .expect("update restore logs");

        let logs = db.get_operation_logs(Some(10)).expect("operation logs");
        assert_eq!(logs[0].restore_status, "failed");
        assert_eq!(
            logs[0].restore_error.as_deref(),
            Some("Target file already exists.")
        );
    }

    #[test]
    fn update_operation_restore_logs_marks_unavailable_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-unavailable", "batch-unavailable", "skipped");
        log.can_undo = false;
        log.can_restore = false;
        db.save_operation_logs("batch-unavailable", &[log.clone()])
            .expect("save operation logs");

        log.restore_status = "unavailable".to_string();
        log.restore_error = Some("Only successful operations can be restored.".to_string());
        db.update_operation_restore_logs(&[log])
            .expect("update restore logs");

        let logs = db.get_operation_logs(Some(10)).expect("operation logs");
        assert_eq!(logs[0].restore_status, "unavailable");
        assert!(!logs[0].can_restore);
        assert_eq!(
            logs[0].restore_error.as_deref(),
            Some("Only successful operations can be restored.")
        );
    }

    #[test]
    fn build_fts_query_quotes_terms_without_breaking_chinese_or_punctuation() {
        let query = build_fts_query("项目\"报告 final-v1.pdf").expect("query");

        assert_eq!(query, "\"项目\"\"报告\" AND \"final-v1.pdf\"");
    }

    fn insert_test_file(
        db: &Database,
        id: &str,
        name: &str,
        extension: &str,
        size: i64,
        mtime: i64,
    ) {
        db.insert_file(InsertFileRequest {
            id: id.to_string(),
            path: format!("/test/virtual/documents/{name}"),
            name: name.to_string(),
            extension: extension.to_string(),
            size,
            mtime,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert file");
    }

    fn operation_log(id: &str, batch_id: &str, status: &str) -> OperationLogDto {
        let success = status == "success";
        OperationLogDto {
            id: id.to_string(),
            batch_id: batch_id.to_string(),
            operation_type: "move".to_string(),
            source_path: "/tmp/source.txt".to_string(),
            target_path: "/tmp/target.txt".to_string(),
            old_name: "source.txt".to_string(),
            new_name: "target.txt".to_string(),
            status: status.to_string(),
            error_message: None,
            created_at: "1900000000123".to_string(),
            can_undo: success,
            path_before: "/tmp/source.txt".to_string(),
            path_after: "/tmp/target.txt".to_string(),
            name_before: "source.txt".to_string(),
            name_after: "target.txt".to_string(),
            can_restore: success,
            restored_at: None,
            restore_status: "not_restored".to_string(),
            restore_error: None,
        }
    }

    fn operation_batch_status(db: &Database, batch_id: &str) -> String {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            "SELECT status FROM operation_batches WHERE id = ?1",
            params![batch_id],
            |row| row.get(0),
        )
        .expect("operation batch status")
    }

    fn stale_state(db: &Database, path: &str) -> Option<(bool, bool)> {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            "SELECT is_stale, last_seen_at FROM files WHERE path = ?1",
            params![path],
            |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, i64>(1)? > 0)),
        )
        .optional()
        .expect("stale state")
    }

    fn file_classification(db: &Database, path: &str) -> Option<(String, String, bool)> {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            "SELECT purpose, lifecycle, is_stale FROM files WHERE path = ?1",
            params![path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .expect("file classification")
    }

    fn set_file_lifecycle(db: &Database, path: &str, lifecycle: &str) {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            "UPDATE files SET lifecycle = ?2 WHERE path = ?1",
            params![path, lifecycle],
        )
        .expect("set lifecycle");
    }

    fn set_file_mtime(db: &Database, path: &str, mtime: i64) {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            "UPDATE files SET mtime = ?2 WHERE path = ?1",
            params![path, mtime],
        )
        .expect("set mtime");
    }

    fn set_file_size(db: &Database, path: &str, size: i64) {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            "UPDATE files SET size = ?2 WHERE path = ?1",
            params![path, size],
        )
        .expect("set size");
    }

    fn classification_fingerprint(db: &Database, path: &str) -> Option<(i64, String, i64, i64)> {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            r#"
            SELECT last_classified_at,
                   classified_rule_version,
                   last_classified_mtime,
                   last_classified_size
            FROM files
            WHERE path = ?1
            "#,
            params![path],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .expect("classification fingerprint")
    }

    fn name_contains_rule(id: &str, name: &str, purpose: &str) -> Rule {
        Rule {
            id: id.to_string(),
            name: name.to_string(),
            source: "user".to_string(),
            enabled: true,
            priority: 200.0,
            weight: 100.0,
            root_operator: "OR".to_string(),
            groups: vec![RuleConditionGroup {
                id: format!("{id}-group"),
                operator: "AND".to_string(),
                conditions: vec![RuleCondition {
                    id: format!("{id}-condition"),
                    field: "name".to_string(),
                    operator: "contains".to_string(),
                    value: Value::String("special".to_string()),
                }],
            }],
            action: RuleAction {
                purpose: Some(purpose.to_string()),
                lifecycle: Some("Inbox".to_string()),
                context: Some("D1 Test".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Keep".to_string()),
                target_template: None,
                rename_template: None,
            },
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn user_rule_for_persistence(id: &str, name: &str, priority: f64) -> Rule {
        Rule {
            id: id.to_string(),
            name: name.to_string(),
            source: "user".to_string(),
            enabled: true,
            priority,
            weight: 42.5,
            root_operator: "AND".to_string(),
            groups: vec![RuleConditionGroup {
                id: format!("{id}-group"),
                operator: "AND".to_string(),
                conditions: vec![RuleCondition {
                    id: format!("{id}-condition"),
                    field: "extension".to_string(),
                    operator: "equals".to_string(),
                    value: Value::String("pdf".to_string()),
                }],
            }],
            action: RuleAction {
                purpose: Some("Document".to_string()),
                lifecycle: Some("Archive".to_string()),
                context: Some("Persistence Test".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("{home}/Archive".to_string()),
                rename_template: Some("{name}".to_string()),
            },
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn assert_rule_matches(actual: &Rule, expected: &Rule) {
        assert_eq!(actual.id, expected.id);
        assert_eq!(actual.name, expected.name);
        assert_eq!(actual.source, "user");
        assert_eq!(actual.enabled, expected.enabled);
        assert_eq!(actual.priority, expected.priority);
        assert_eq!(actual.weight, expected.weight);
        assert_eq!(actual.root_operator, expected.root_operator);
        assert_eq!(
            serde_json::to_value(&actual.groups).expect("actual groups json"),
            serde_json::to_value(&expected.groups).expect("expected groups json")
        );
        assert_eq!(
            serde_json::to_value(&actual.action).expect("actual action json"),
            serde_json::to_value(&expected.action).expect("expected action json")
        );
        assert!(!actual.created_at.is_empty());
        assert!(!actual.updated_at.is_empty());
    }

    fn insert_system_rule_row(db: &Database, id: &str) {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            r#"
            INSERT INTO rules (
                id,
                name,
                source,
                enabled,
                priority,
                weight,
                root_operator,
                groups_json,
                action_json,
                created_at,
                updated_at
            )
            VALUES (?1, 'System Rule', 'system', 1, 1000, 100, 'AND', '[]', '{}', '2026-06-21T00:00:00Z', '2026-06-21T00:00:00Z')
            "#,
            params![id],
        )
        .expect("insert system rule row");
    }

    fn rule_source_by_id(db: &Database, id: &str) -> Option<String> {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            "SELECT source FROM rules WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .expect("rule source")
    }

    fn test_db_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("zen-canvas-db-test-{nonce}.sqlite3"))
    }

    fn test_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("zen-canvas-db-file-test-{nonce}"));
        fs::create_dir_all(&dir).expect("test dir");
        dir
    }

    fn normalized_test_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }
}
