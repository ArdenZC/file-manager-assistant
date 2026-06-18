use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::State;
use thiserror::Error;
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

#[derive(Debug, Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database lock was poisoned")]
    Poisoned,
}

pub struct Database {
    path: PathBuf,
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone)]
struct IndexedFileRow {
    id: String,
    path: String,
    name: String,
    extension: String,
    size: i64,
    mtime: i64,
    is_dir: bool,
    state_code: i64,
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

impl Database {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(&path)?;
        configure_connection(&conn)?;
        migrate(&conn)?;

        Ok(Self {
            path,
            conn: Mutex::new(conn),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn init(&self) -> Result<(), DbError> {
        let conn = self.lock_conn()?;
        migrate(&conn)
    }

    pub fn insert_file(&self, file: InsertFileRequest) -> Result<(), DbError> {
        let mut conn = self.lock_conn()?;
        let tx = conn.transaction()?;
        tx.execute(
            r#"
            INSERT INTO files (
                id, path, name, extension, size, mtime, is_dir, state_code
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                name = excluded.name,
                extension = excluded.extension,
                size = excluded.size,
                mtime = excluded.mtime,
                is_dir = excluded.is_dir,
                state_code = excluded.state_code
            "#,
            params![
                file.id,
                file.path,
                file.name,
                file.extension,
                file.size,
                file.mtime,
                bool_to_i64(file.is_dir),
                file.state_code
            ],
        )?;
        tx.commit()?;
        Ok(())
    }

    pub fn search_files(&self, query: &str, limit: Option<u32>) -> Result<Vec<FileSearchResult>, DbError> {
        let Some(fts_query) = build_fts_query(query) else {
            return Ok(Vec::new());
        };

        let limit = i64::from(limit.unwrap_or(50).clamp(1, 200));
        let conn = self.lock_conn()?;
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

    fn list_files(&self) -> Result<Vec<IndexedFileRow>, DbError> {
        let conn = self.lock_conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, path, name, extension, size, mtime, is_dir, state_code
            FROM files
            ORDER BY mtime DESC, name ASC
            "#,
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(IndexedFileRow {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                extension: row.get(3)?,
                size: row.get(4)?,
                mtime: row.get(5)?,
                is_dir: row.get::<_, i64>(6)? != 0,
                state_code: row.get(7)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    fn lock_conn(&self) -> Result<MutexGuard<'_, Connection>, DbError> {
        self.conn.lock().map_err(|_| DbError::Poisoned)
    }
}

#[tauri::command]
pub fn init_db(db: State<'_, Database>) -> Result<(), String> {
    db.init().map_err(command_error)
}

#[tauri::command]
pub fn fetch_database(db: State<'_, Database>) -> Result<Value, String> {
    database_snapshot_json(&db).map_err(command_error)
}

#[tauri::command]
pub fn insert_file(db: State<'_, Database>, file: InsertFileRequest) -> Result<(), String> {
    db.insert_file(file).map_err(command_error)
}

#[tauri::command]
pub fn search_files(
    db: State<'_, Database>,
    query: String,
    limit: Option<u32>,
) -> Result<Vec<FileSearchResult>, String> {
    db.search_files(&query, limit).map_err(command_error)
}

fn configure_connection(conn: &Connection) -> Result<(), DbError> {
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    conn.pragma_update(None, "foreign_keys", "ON")?;
    conn.pragma_update(None, "temp_store", "MEMORY")?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<(), DbError> {
    assert_fts5_available(conn)?;
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

        CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
            name,
            path,
            content='files',
            content_rowid='rowid',
            tokenize='unicode61 remove_diacritics 2',
            prefix='2 3 4'
        );

        CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
            INSERT INTO files_fts(rowid, name, path)
            VALUES (new.rowid, new.name, new.path);
        END;

        CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
            INSERT INTO files_fts(files_fts, rowid, name, path)
            VALUES('delete', old.rowid, old.name, old.path);
        END;

        CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
            INSERT INTO files_fts(files_fts, rowid, name, path)
            VALUES('delete', old.rowid, old.name, old.path);
            INSERT INTO files_fts(rowid, name, path)
            VALUES (new.rowid, new.name, new.path);
        END;
        "#,
    )?;
    Ok(())
}

fn assert_fts5_available(conn: &Connection) -> Result<(), DbError> {
    conn.execute_batch(
        r#"
        CREATE VIRTUAL TABLE temp.fts5_probe USING fts5(value);
        DROP TABLE temp.fts5_probe;
        "#,
    )?;
    Ok(())
}

fn build_fts_query(input: &str) -> Option<String> {
    let tokens = input
        .split(|ch: char| !ch.is_alphanumeric())
        .filter(|token| !token.is_empty())
        .take(12)
        .map(|token| format!("{}*", token.to_lowercase()))
        .collect::<Vec<_>>();

    if tokens.is_empty() {
        None
    } else {
        Some(tokens.join(" AND "))
    }
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

pub fn database_snapshot_json(db: &Database) -> Result<Value, DbError> {
    let rows = db.list_files()?;
    let now = current_timestamp_iso();
    let mut total_size = 0_i64;
    let mut total_files = 0_i64;
    let mut by_type = serde_json::Map::new();
    let mut by_lifecycle = serde_json::Map::new();

    let files = rows
        .iter()
        .map(|row| {
            if !row.is_dir {
                total_files += 1;
                total_size += row.size.max(0);
            }

            let file_type = infer_file_type(&row.extension, row.is_dir);
            increment_json_counter(&mut by_type, file_type);
            increment_json_counter(&mut by_lifecycle, "Inbox");
            let modified_at = unix_seconds_to_iso(row.mtime);

            json!({
                "id": row.id,
                "name": row.name,
                "path": row.path,
                "directory": parent_directory(&row.path),
                "extension": row.extension,
                "size": row.size,
                "file_type": file_type,
                "purpose": "Unknown",
                "lifecycle": "Inbox",
                "context": "",
                "risk_level": "Normal",
                "hash": Value::Null,
                "created_at": modified_at,
                "modified_at": modified_at,
                "scanned_at": now,
                "last_seen_at": now,
                "is_hidden": row.name.starts_with('.'),
                "is_deleted": false,
                "is_duplicate": false,
                "suggested_action": "Keep",
                "suggested_target_path": "",
                "suggested_name": row.name,
                "confidence": 0.5,
                "classification_reason": "Indexed by Zen Canvas Tauri backend.",
                "matched_rules": [],
                "requires_confirmation": false,
                "last_opened_at": Value::Null,
                "open_count": 0,
                "indexed_at": now,
                "source_id": Value::Null,
                "is_stale": false,
                "state_code": row.state_code
            })
        })
        .collect::<Vec<_>>();

    Ok(json!({
        "stats": {
            "totalFiles": total_files,
            "totalSize": total_size,
            "diskTotalSize": 0,
            "diskFreeSize": 0,
            "diskUsageRatio": 0,
            "duplicateFiles": 0,
            "largeFiles": 0,
            "sensitiveFiles": 0,
            "needsConfirmation": 0,
            "byType": Value::Object(by_type),
            "byLifecycle": Value::Object(by_lifecycle),
            "lastScannedAt": if files.is_empty() { Value::Null } else { json!(now) }
        },
        "files": files,
        "rules": [],
        "operations": [],
        "scanRoots": [],
        "searchSources": [],
        "searchIndex": {
            "total_files": rows.len(),
            "indexed_files": rows.len(),
            "last_indexed_at": if rows.is_empty() { Value::Null } else { json!(now) },
            "stale_sources": 0
        }
    }))
}

fn increment_json_counter(map: &mut serde_json::Map<String, Value>, key: &str) {
    let current = map.get(key).and_then(Value::as_i64).unwrap_or(0);
    map.insert(key.to_string(), json!(current + 1));
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
        | "cpp" | "h" | "hpp" | "cs" | "php" | "rb" | "html" | "css" | "scss" | "json"
        | "yaml" | "yml" | "toml" => "Code",
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
    fn fetch_database_snapshot_includes_indexed_files_and_stats() {
        let db = Database::open(test_db_path()).expect("open test database");
        db.insert_file(InsertFileRequest {
            id: "file-1".to_string(),
            path: "C:/Users/77588/Documents/report.pdf".to_string(),
            name: "report.pdf".to_string(),
            extension: "pdf".to_string(),
            size: 2048,
            mtime: 1_800_000_000,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert file");

        let snapshot = database_snapshot_json(&db).expect("snapshot");

        assert_eq!(snapshot["stats"]["totalFiles"], 1);
        assert_eq!(snapshot["stats"]["totalSize"], 2048);
        assert_eq!(snapshot["searchIndex"]["indexed_files"], 1);
        assert_eq!(snapshot["files"][0]["name"], "report.pdf");
        assert_eq!(snapshot["files"][0]["directory"], "C:/Users/77588/Documents");
    }

    fn test_db_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("zen-canvas-db-test-{nonce}.sqlite3"))
    }
}
