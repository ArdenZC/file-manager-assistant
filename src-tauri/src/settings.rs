use crate::db::{Database, DbError};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

pub const APP_SETTINGS_KEY: &str = "app_settings_v1";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub close_behavior: String,
    pub folder_naming_language: String,
    pub default_scan_folders: Vec<String>,
    pub restore_retention_days: i64,
    pub launch_at_login: bool,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: "ask".to_string(),
            folder_naming_language: "en".to_string(),
            default_scan_folders: vec!["Desktop".into(), "Downloads".into(), "Documents".into()],
            restore_retention_days: 30,
            launch_at_login: false,
        }
    }
}

pub fn default_settings_json() -> Result<String, DbError> {
    serde_json::to_string(&AppSettings::default()).map_err(DbError::from)
}

pub fn get_app_settings(db: &Database) -> Result<AppSettings, DbError> {
    let conn = db.conn()?;
    let settings_json = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![APP_SETTINGS_KEY],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    match settings_json {
        Some(value) => serde_json::from_str(&value).map_err(DbError::from),
        None => Ok(AppSettings::default()),
    }
}

pub fn save_app_settings(db: &Database, settings: &AppSettings) -> Result<(), DbError> {
    let conn = db.conn()?;
    let settings_json = serde_json::to_string(settings)?;
    conn.execute(
        r#"
        INSERT INTO app_settings (key, value)
        VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value
        "#,
        params![APP_SETTINGS_KEY, settings_json],
    )?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(db: State<'_, Database>) -> Result<AppSettings, String> {
    get_app_settings(&db).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_settings(
    db: State<'_, Database>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    save_app_settings(&db, &settings).map_err(|error| error.to_string())?;
    Ok(settings)
}
