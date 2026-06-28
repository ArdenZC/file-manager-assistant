use super::*;
use rusqlite::{params, Connection, OptionalExtension};
use std::sync::OnceLock;

/// 当前期望的 schema 版本号，每次需要改动 schema 时 +1
const CURRENT_SCHEMA_VERSION: i32 = 11;
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

pub(crate) fn migrate(conn: &Connection) -> Result<(), DbError> {
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
    if version < 9 {
        execute_column_migrations(
            conn,
            &["ALTER TABLE files ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';"],
        )?;
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_files_dedupe
            ON files(size, content_hash)
            WHERE is_dir = 0 AND size > 0;
            "#,
        )?;
        set_schema_version(conn, 9)?;
    }
    if version < 10 {
        execute_column_migrations(
            conn,
            &[r#"
                ALTER TABLE files ADD COLUMN classification_status TEXT NOT NULL DEFAULT 'unclassified'
                CHECK (classification_status IN ('unclassified', 'classified'));
            "#],
        )?;
        conn.execute(
            r#"
            UPDATE files
            SET classification_status = 'classified'
            WHERE last_classified_at > 0
               OR matched_rules <> '[]'
               OR purpose <> 'Unknown'
            "#,
            [],
        )?;
        set_schema_version(conn, 10)?;
    }
    if version < 11 {
        conn.execute_batch(
            r#"
            CREATE INDEX IF NOT EXISTS idx_files_active_mtime
            ON files(is_stale, mtime DESC);

            CREATE INDEX IF NOT EXISTS idx_files_lifecycle_mtime
            ON files(is_stale, lifecycle, mtime DESC);

            CREATE INDEX IF NOT EXISTS idx_files_action_mtime
            ON files(is_stale, suggested_action, mtime DESC);

            CREATE INDEX IF NOT EXISTS idx_files_review_mtime
            ON files(is_stale, requires_confirmation, suggested_action, mtime DESC);

            CREATE INDEX IF NOT EXISTS idx_files_risk_mtime
            ON files(is_stale, risk_level, mtime DESC);

            CREATE INDEX IF NOT EXISTS idx_files_scope_path
            ON files(is_stale, path);
            "#,
        )?;
        set_schema_version(conn, 11)?;
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
