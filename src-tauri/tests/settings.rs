use rusqlite::{params, Connection};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zen_canvas_tauri::{
    db::Database,
    settings::{get_app_settings, save_app_settings, AppSettings, APP_SETTINGS_KEY},
};

#[test]
fn new_database_creates_default_app_settings_row() {
    let db = Database::open(test_db_path()).expect("open test database");
    let conn = Connection::open(db.path()).expect("open migrated database");

    let version: i64 = conn
        .query_row("SELECT user_version FROM pragma_user_version", [], |row| {
            row.get(0)
        })
        .expect("schema version");
    let value: String = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![APP_SETTINGS_KEY],
            |row| row.get(0),
        )
        .expect("default app settings row");
    let settings: AppSettings = serde_json::from_str(&value).expect("deserialize settings");

    assert_eq!(version, 8);
    assert_eq!(settings.close_behavior, "ask");
    assert_eq!(settings.folder_naming_language, "en");
    assert_eq!(
        settings.default_scan_folders,
        vec!["Desktop", "Downloads", "Documents"]
    );
    assert_eq!(settings.restore_retention_days, 30);
    assert!(!settings.launch_at_login);
}

#[test]
fn schema_7_database_migrates_to_settings_without_losing_existing_rows() {
    let path = test_db_path();
    create_schema_7_database(&path);

    let db = Database::open(&path).expect("migrate schema 7 database");
    let conn = Connection::open(db.path()).expect("open migrated database");

    let version: i64 = conn
        .query_row("SELECT user_version FROM pragma_user_version", [], |row| {
            row.get(0)
        })
        .expect("schema version");
    let file_name: String = conn
        .query_row(
            "SELECT name FROM files WHERE id = 'file-legacy'",
            [],
            |row| row.get(0),
        )
        .expect("legacy file");
    let rule_name: String = conn
        .query_row(
            "SELECT name FROM rules WHERE id = 'rule-legacy'",
            [],
            |row| row.get(0),
        )
        .expect("legacy rule");
    let default_settings = get_app_settings(&db).expect("default settings");

    assert_eq!(version, 8);
    assert_eq!(file_name, "legacy.pdf");
    assert_eq!(rule_name, "Legacy Rule");
    assert_eq!(
        default_settings.default_scan_folders,
        vec!["Desktop", "Downloads", "Documents"]
    );
}

#[test]
fn app_settings_roundtrip_persists_single_json_row() {
    let db = Database::open(test_db_path()).expect("open test database");
    let mut settings = AppSettings::default();
    settings.close_behavior = "quit".to_string();
    settings.folder_naming_language = "zh".to_string();
    settings.default_scan_folders = vec!["Downloads".to_string()];
    settings.restore_retention_days = 90;
    settings.launch_at_login = true;

    save_app_settings(&db, &settings).expect("save settings");
    let loaded = get_app_settings(&db).expect("load settings");
    let conn = Connection::open(db.path()).expect("open migrated database");
    let row_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0))
        .expect("settings row count");

    assert_eq!(loaded.close_behavior, "quit");
    assert_eq!(loaded.folder_naming_language, "zh");
    assert_eq!(loaded.default_scan_folders, vec!["Downloads"]);
    assert_eq!(loaded.restore_retention_days, 90);
    assert!(loaded.launch_at_login);
    assert_eq!(row_count, 1);
}

#[test]
fn prune_operation_logs_removes_expired_logs_and_orphan_batches() {
    let db = Database::open(test_db_path()).expect("open test database");
    let conn = Connection::open(db.path()).expect("open migrated database");
    let recent_timestamp = current_timestamp_ms();

    insert_batch(&conn, "batch-old", 0);
    insert_batch(&conn, "batch-recent", recent_timestamp);
    insert_batch(&conn, "batch-orphan", 0);
    insert_operation_log(&conn, "log-old", "batch-old", 0);
    insert_operation_log(&conn, "log-recent", "batch-recent", recent_timestamp);

    db.prune_operation_logs(30).expect("prune operation logs");

    let log_ids = string_column_values(&conn, "SELECT id FROM operation_logs ORDER BY id");
    let batch_ids = string_column_values(&conn, "SELECT id FROM operation_batches ORDER BY id");

    assert_eq!(log_ids, vec!["log-recent"]);
    assert_eq!(batch_ids, vec!["batch-recent"]);
}

fn create_schema_7_database(path: &Path) {
    let conn = Connection::open(path).expect("open schema 7 database");
    conn.execute_batch(
        r#"
        CREATE TABLE files (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        INSERT INTO files (id, name) VALUES ('file-legacy', 'legacy.pdf');
        CREATE TABLE rules (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL
        );
        INSERT INTO rules (id, name) VALUES ('rule-legacy', 'Legacy Rule');
        PRAGMA user_version = 7;
        "#,
    )
    .expect("create schema 7 database");
}

fn insert_batch(conn: &Connection, id: &str, created_at: i64) {
    conn.execute(
        "INSERT INTO operation_batches (id, created_at, status) VALUES (?1, ?2, 'success')",
        params![id, created_at],
    )
    .expect("insert operation batch");
}

fn insert_operation_log(conn: &Connection, id: &str, batch_id: &str, created_at: i64) {
    conn.execute(
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
        VALUES (?1, ?2, 'move', '/tmp/source.txt', '/tmp/target.txt', 'source.txt', 'target.txt', 'success', NULL, ?3, 1, '/tmp/source.txt', '/tmp/target.txt', 'source.txt', 'target.txt', 1, NULL, 'not_restored', NULL)
        "#,
        params![id, batch_id, created_at],
    )
    .expect("insert operation log");
}

fn string_column_values(conn: &Connection, sql: &str) -> Vec<String> {
    let mut stmt = conn.prepare(sql).expect("prepare query");
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query rows");
    rows.map(|row| row.expect("row value")).collect()
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).expect("timestamp fits i64"))
        .expect("clock")
}

fn test_db_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("zen-canvas-settings-test-{nonce}.sqlite3"))
}
