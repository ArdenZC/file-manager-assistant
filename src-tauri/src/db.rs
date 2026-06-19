use r2d2::{Pool, PooledConnection};
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::{SystemTime, UNIX_EPOCH},
};
use sysinfo::Disks;
use tauri::State;
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
}

const CLASSIFY_BATCH_SIZE: usize = 500;

/// 当前期望的 schema 版本号，每次需要改动 schema 时 +1
const CURRENT_SCHEMA_VERSION: i32 = 3;

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

#[derive(Debug, Clone, Deserialize)]
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

#[derive(Debug, Clone, Deserialize)]
pub struct RuleConditionGroup {
    pub id: String,
    #[serde(default = "default_and")]
    pub operator: String,
    #[serde(default)]
    pub conditions: Vec<RuleCondition>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RuleCondition {
    pub id: String,
    pub field: String,
    pub operator: String,
    pub value: Value,
}

#[derive(Debug, Clone, Default, Deserialize)]
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
    pub needs_confirmation: i64,
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

        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
            INSERT INTO files (
                id, path, name, extension, size, mtime, ctime, is_dir, state_code, file_type, suggested_name
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
                END
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
                    file.name
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

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
                DELETE FROM files
                WHERE path = ?1
                   OR path LIKE ?2 ESCAPE '~'
                   OR path LIKE ?3 ESCAPE '~'
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

                let escaped_path = escape_like_pattern(path);
                let slash_descendants = format!("{escaped_path}/%");
                let backslash_descendants = format!("{escaped_path}\\%");
                removed += stmt.execute(params![path, slash_descendants, backslash_descendants])?;
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn execute_rules_on_inbox(
        &self,
        rules: Vec<Rule>,
    ) -> Result<RuleExecutionSummary, DbError> {
        let all_rules: Vec<Rule> = built_in_rules()
            .into_iter()
            .chain(rules.into_iter().filter(|rule| rule.enabled))
            .collect();
        let read_conn = self.conn()?;
        let mut write_conn = self.conn()?;
        let mut stmt = read_conn.prepare(
            r#"
                SELECT id, path, name, extension, size, mtime, ctime, is_dir, state_code,
                       file_type, purpose, lifecycle, context, risk_level, suggested_action,
                       suggested_target_path, suggested_name, confidence, classification_reason,
                       matched_rules, requires_confirmation
                FROM files
                WHERE lifecycle = 'Inbox'
                ORDER BY mtime DESC, name COLLATE NOCASE ASC
                "#,
        )?;
        let mut rows = stmt.query([])?;

        let mut scanned = 0_i64;
        let mut updated = 0_i64;
        let mut needs_confirmation = 0_i64;
        let mut batch = Vec::with_capacity(CLASSIFY_BATCH_SIZE);

        while let Some(row) = rows.next()? {
            batch.push(indexed_file_from_row(row)?);
            scanned += 1;

            if batch.len() == CLASSIFY_BATCH_SIZE {
                let batch_summary =
                    execute_classification_batch(&mut write_conn, &batch, &all_rules)?;
                updated += batch_summary.updated;
                needs_confirmation += batch_summary.needs_confirmation;
                batch.clear();
            }
        }

        if !batch.is_empty() {
            let batch_summary = execute_classification_batch(&mut write_conn, &batch, &all_rules)?;
            updated += batch_summary.updated;
            needs_confirmation += batch_summary.needs_confirmation;
        }

        Ok(RuleExecutionSummary {
            scanned,
            updated,
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
                "SELECT COUNT(*) FROM files_fts WHERE files_fts MATCH ?1",
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
                    bm25(files_fts, 6.0, 1.5) AS rank
                FROM files_fts
                JOIN files AS f ON f.rowid = files_fts.rowid
                WHERE files_fts MATCH ?1
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

        let total = conn.query_row("SELECT COUNT(*) FROM files", [], |row| row.get(0))?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, path, name, extension, size, mtime, ctime, is_dir, state_code,
                   file_type, purpose, lifecycle, context, risk_level, suggested_action,
                   suggested_target_path, suggested_name, confidence, classification_reason,
                   matched_rules, requires_confirmation
            FROM files
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

    fn conn(&self) -> Result<PooledConnection<SqliteConnectionManager>, DbError> {
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

fn command_error(error: DbError) -> String {
    error.to_string()
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
    })
}

fn file_record_from_indexed(row: IndexedFileRow, now: &str) -> FileRecordDto {
    let created_at = unix_seconds_to_iso(if row.ctime == 0 { row.mtime } else { row.ctime });
    let modified_at = unix_seconds_to_iso(row.mtime);
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
        last_seen_at: now.to_string(),
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
        is_stale: false,
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
) -> Result<RuleExecutionSummary, DbError> {
    let mut updated = 0_i64;
    let mut needs_confirmation = 0_i64;
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
                    requires_confirmation = ?13
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
                bool_to_i64(classification.requires_confirmation)
            ])?;
            updated += 1;
        }
    }
    tx.commit()?;

    Ok(RuleExecutionSummary {
        scanned: batch.len() as i64,
        updated,
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

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
    fn remove_files_by_paths_deletes_exact_paths_descendants_and_fts_rows() {
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

    fn test_db_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("zen-canvas-db-test-{nonce}.sqlite3"))
    }
}
