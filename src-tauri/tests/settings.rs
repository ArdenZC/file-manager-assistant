use rusqlite::{params, Connection};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zen_canvas_tauri::{
    db::Database,
    settings::{
        get_app_settings, save_app_settings, save_app_settings_with_launch_at_login,
        sync_launch_at_login_from_system, AppSettings, LaunchAtLoginController, ScanRootSetting,
        APP_SETTINGS_KEY,
    },
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

    assert_eq!(version, 11);
    assert_eq!(settings.close_behavior, "ask");
    assert_eq!(settings.folder_naming_language, "en");
    assert_default_scan_roots(&settings.default_scan_folders);
    assert_eq!(settings.restore_retention_days, 30);
    assert!(!settings.launch_at_login);
    assert_eq!(settings.search_hotkey, "CmdOrCtrl+K");
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

    assert_eq!(version, 11);
    assert_eq!(file_name, "legacy.pdf");
    assert_eq!(rule_name, "Legacy Rule");
    assert_default_scan_roots(&default_settings.default_scan_folders);
    assert_eq!(default_settings.search_hotkey, "CmdOrCtrl+K");
}

#[test]
fn app_settings_roundtrip_persists_single_json_row() {
    let db = Database::open(test_db_path()).expect("open test database");
    let mut settings = AppSettings::default();
    settings.close_behavior = "quit".to_string();
    settings.folder_naming_language = "zh".to_string();
    settings.default_scan_folders = vec![scan_root(
        "downloads",
        "/Users/zen/Downloads",
        "Downloads",
        true,
    )];
    settings.restore_retention_days = 90;
    settings.launch_at_login = true;
    settings.search_hotkey = "Alt+Space".to_string();

    save_app_settings(&db, &settings).expect("save settings");
    let loaded = get_app_settings(&db).expect("load settings");
    let conn = Connection::open(db.path()).expect("open migrated database");
    let row_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM app_settings", [], |row| row.get(0))
        .expect("settings row count");

    assert_eq!(loaded.close_behavior, "quit");
    assert_eq!(loaded.folder_naming_language, "zh");
    assert_eq!(
        loaded.default_scan_folders,
        vec![scan_root(
            "downloads",
            "/Users/zen/Downloads",
            "Downloads",
            true
        )]
    );
    assert_eq!(loaded.restore_retention_days, 90);
    assert!(loaded.launch_at_login);
    assert_eq!(loaded.search_hotkey, "Alt+Space");
    assert_eq!(row_count, 1);
}

#[test]
fn legacy_string_default_scan_folders_load_as_absolute_scan_roots() {
    let db = Database::open(test_db_path()).expect("open test database");
    let conn = Connection::open(db.path()).expect("open migrated database");
    conn.execute(
        r#"
        INSERT INTO app_settings (key, value)
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
        "#,
        params![
            APP_SETTINGS_KEY,
            r#"{
              "closeBehavior":"ask",
              "folderNamingLanguage":"en",
              "defaultScanFolders":["Desktop","Downloads","Documents"],
              "restoreRetentionDays":30,
              "launchAtLogin":false
            }"#
        ],
    )
    .expect("insert legacy settings");

    let loaded = get_app_settings(&db).expect("load migrated legacy settings");

    assert_default_scan_roots(&loaded.default_scan_folders);
    assert_eq!(loaded.search_hotkey, "CmdOrCtrl+K");
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

#[test]
fn save_settings_with_launch_at_login_enables_autostart_before_persisting() {
    let db = Database::open(test_db_path()).expect("open test database");
    let controller = RecordingLaunchAtLoginController::new(false);
    let mut settings = AppSettings::default();
    settings.launch_at_login = true;

    save_app_settings_with_launch_at_login(&db, &settings, &controller).expect("save settings");
    let loaded = get_app_settings(&db).expect("load settings");

    assert!(loaded.launch_at_login);
    assert_eq!(controller.calls(), vec!["enable"]);
}

#[test]
fn save_settings_with_launch_at_login_disables_autostart_before_persisting() {
    let db = Database::open(test_db_path()).expect("open test database");
    let controller = RecordingLaunchAtLoginController::new(true);
    let mut settings = AppSettings::default();
    settings.launch_at_login = true;
    save_app_settings(&db, &settings).expect("save enabled settings");
    settings.launch_at_login = false;

    save_app_settings_with_launch_at_login(&db, &settings, &controller).expect("save settings");
    let loaded = get_app_settings(&db).expect("load settings");

    assert!(!loaded.launch_at_login);
    assert_eq!(controller.calls(), vec!["disable"]);
}

#[test]
fn save_settings_with_launch_at_login_does_not_persist_when_autostart_sync_fails() {
    let db = Database::open(test_db_path()).expect("open test database");
    let controller = RecordingLaunchAtLoginController::new(false).fail_enable();
    let mut settings = AppSettings::default();
    settings.launch_at_login = true;

    let result = save_app_settings_with_launch_at_login(&db, &settings, &controller);
    let loaded = get_app_settings(&db).expect("load settings");

    assert!(result.is_err());
    assert!(!loaded.launch_at_login);
    assert_eq!(controller.calls(), vec!["enable"]);
}

#[test]
fn startup_launch_at_login_sync_uses_system_truth() {
    let db = Database::open(test_db_path()).expect("open test database");
    let controller = RecordingLaunchAtLoginController::new(false);
    let mut settings = AppSettings::default();
    settings.launch_at_login = true;
    save_app_settings(&db, &settings).expect("save stale settings");

    let synced =
        sync_launch_at_login_from_system(&db, &settings, &controller).expect("sync settings");
    let loaded = get_app_settings(&db).expect("load settings");

    assert!(!synced.launch_at_login);
    assert!(!loaded.launch_at_login);
    assert_eq!(controller.calls(), vec!["is_enabled"]);
}

fn create_schema_7_database(path: &Path) {
    let conn = Connection::open(path).expect("open schema 7 database");
    conn.execute_batch(
        r#"
        CREATE TABLE files (
            id TEXT PRIMARY KEY,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            extension TEXT NOT NULL DEFAULT '',
            size INTEGER NOT NULL DEFAULT 0,
            mtime INTEGER NOT NULL DEFAULT 0,
            is_dir INTEGER NOT NULL DEFAULT 0 CHECK (is_dir IN (0, 1)),
            state_code INTEGER NOT NULL DEFAULT 0,
            file_type TEXT NOT NULL DEFAULT 'Other',
            purpose TEXT NOT NULL DEFAULT 'Unknown',
            lifecycle TEXT NOT NULL DEFAULT 'Inbox',
            context TEXT NOT NULL DEFAULT '',
            risk_level TEXT NOT NULL DEFAULT 'Normal',
            suggested_action TEXT NOT NULL DEFAULT 'Keep',
            suggested_target_path TEXT NOT NULL DEFAULT '',
            suggested_name TEXT NOT NULL DEFAULT '',
            confidence REAL NOT NULL DEFAULT 0.5,
            classification_reason TEXT NOT NULL DEFAULT 'Indexed by Zen Canvas Tauri backend.',
            matched_rules TEXT NOT NULL DEFAULT '[]',
            requires_confirmation INTEGER NOT NULL DEFAULT 0,
            ctime INTEGER NOT NULL DEFAULT 0,
            is_stale INTEGER NOT NULL DEFAULT 0,
            last_seen_at INTEGER NOT NULL DEFAULT 0,
            last_classified_at INTEGER NOT NULL DEFAULT 0,
            classified_rule_version TEXT NOT NULL DEFAULT '',
            last_classified_mtime INTEGER NOT NULL DEFAULT 0,
            last_classified_size INTEGER NOT NULL DEFAULT 0
        );
        INSERT INTO files (id, path, name, extension, size)
        VALUES ('file-legacy', '/legacy/legacy.pdf', 'legacy.pdf', 'pdf', 2048);
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

fn scan_root(id: &str, path: &str, label: &str, enabled: bool) -> ScanRootSetting {
    ScanRootSetting {
        id: id.to_string(),
        path: path.to_string(),
        label: label.to_string(),
        enabled,
        created_at: "2026-06-22T00:00:00.000Z".to_string(),
    }
}

fn assert_default_scan_roots(roots: &[ScanRootSetting]) {
    assert_eq!(roots.len(), 3);
    for label in ["Desktop", "Downloads", "Documents"] {
        let root = roots
            .iter()
            .find(|root| root.label == label)
            .unwrap_or_else(|| panic!("missing {label} root"));
        assert!(root.enabled);
        assert!(!root.id.is_empty());
        assert!(!root.created_at.is_empty());
        assert!(
            root.path.replace('\\', "/").ends_with(&format!("/{label}")),
            "{} did not end with /{label}",
            root.path
        );
    }
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

#[derive(Default)]
struct RecordingLaunchAtLoginController {
    enabled: bool,
    fail_enable: bool,
    calls: std::cell::RefCell<Vec<&'static str>>,
}

impl RecordingLaunchAtLoginController {
    fn new(enabled: bool) -> Self {
        Self {
            enabled,
            fail_enable: false,
            calls: std::cell::RefCell::new(Vec::new()),
        }
    }

    fn fail_enable(mut self) -> Self {
        self.fail_enable = true;
        self
    }

    fn calls(&self) -> Vec<&'static str> {
        self.calls.borrow().clone()
    }
}

impl LaunchAtLoginController for RecordingLaunchAtLoginController {
    fn enable(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("enable");
        if self.fail_enable {
            Err("enable failed".to_string())
        } else {
            Ok(())
        }
    }

    fn disable(&self) -> Result<(), String> {
        self.calls.borrow_mut().push("disable");
        Ok(())
    }

    fn is_enabled(&self) -> Result<bool, String> {
        self.calls.borrow_mut().push("is_enabled");
        Ok(self.enabled)
    }
}

fn test_db_path() -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    std::env::temp_dir().join(format!("zen-canvas-settings-test-{nonce}.sqlite3"))
}
