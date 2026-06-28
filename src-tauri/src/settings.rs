use crate::{
    db::{Database, DbError},
    watcher::{emit_file_watcher_error, reload_file_watcher_for_settings, FileWatcherManager},
};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_autostart::{AutoLaunchManager, ManagerExt};
use thiserror::Error;

pub const APP_SETTINGS_KEY: &str = "app_settings_v1";
pub const DEFAULT_SEARCH_HOTKEY: &str = "CmdOrCtrl+K";
const DEFAULT_SCAN_ROOT_CREATED_AT: &str = "1970-01-01T00:00:00.000Z";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ScanRootSetting {
    pub id: String,
    pub path: String,
    pub label: String,
    pub enabled: bool,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    pub close_behavior: String,
    pub folder_naming_language: String,
    #[serde(
        default = "default_scan_roots",
        deserialize_with = "deserialize_scan_roots"
    )]
    pub default_scan_folders: Vec<ScanRootSetting>,
    pub restore_retention_days: i64,
    pub launch_at_login: bool,
    #[serde(default = "default_search_hotkey")]
    pub search_hotkey: String,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            close_behavior: "ask".to_string(),
            folder_naming_language: "en".to_string(),
            default_scan_folders: default_scan_roots(),
            restore_retention_days: 30,
            launch_at_login: false,
            search_hotkey: DEFAULT_SEARCH_HOTKEY.to_string(),
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
    let settings_json = serde_json::to_string(&normalized_app_settings(settings))?;
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

fn deserialize_scan_roots<'de, D>(deserializer: D) -> Result<Vec<ScanRootSetting>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = Vec::<Value>::deserialize(deserializer)?;
    Ok(scan_roots_from_values(values, dirs::home_dir().as_deref()))
}

fn default_scan_roots() -> Vec<ScanRootSetting> {
    default_scan_roots_for_home(dirs::home_dir().as_deref())
}

fn default_search_hotkey() -> String {
    DEFAULT_SEARCH_HOTKEY.to_string()
}

fn default_scan_roots_for_home(home: Option<&Path>) -> Vec<ScanRootSetting> {
    let Some(home) = home else {
        return Vec::new();
    };

    ["Desktop", "Downloads", "Documents"]
        .into_iter()
        .map(|label| legacy_scan_root(label, Some(home), true))
        .collect()
}

fn scan_roots_from_values(values: Vec<Value>, home: Option<&Path>) -> Vec<ScanRootSetting> {
    let mut roots = Vec::new();

    for value in values {
        let root = match value {
            Value::String(folder) => legacy_scan_root(&folder, home, true),
            Value::Object(object) => {
                let path = object
                    .get("path")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .trim()
                    .to_string();
                if path.is_empty() {
                    continue;
                }
                let label = object
                    .get("label")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| value.trim().to_string())
                    .unwrap_or_else(|| scan_root_label(&path));
                let id = object
                    .get("id")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .map(|value| value.trim().to_string())
                    .unwrap_or_else(|| scan_root_id(&path));
                let enabled = object
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(true);
                let created_at = object
                    .get("createdAt")
                    .or_else(|| object.get("created_at"))
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty())
                    .unwrap_or(DEFAULT_SCAN_ROOT_CREATED_AT)
                    .to_string();
                ScanRootSetting {
                    id,
                    path: normalize_scan_root_path(&path),
                    label,
                    enabled,
                    created_at,
                }
            }
            _ => continue,
        };
        push_unique_scan_root(&mut roots, root);
    }

    roots
}

fn normalized_app_settings(settings: &AppSettings) -> AppSettings {
    let values = settings
        .default_scan_folders
        .iter()
        .cloned()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .unwrap_or_default();
    let mut next = settings.clone();
    next.default_scan_folders = scan_roots_from_values(values, dirs::home_dir().as_deref());
    if next.search_hotkey.trim().is_empty() {
        next.search_hotkey = default_search_hotkey();
    }
    next
}

fn legacy_scan_root(folder: &str, home: Option<&Path>, enabled: bool) -> ScanRootSetting {
    let trimmed = folder.trim();
    let path = if looks_absolute_path(trimmed) {
        PathBuf::from(trimmed)
    } else {
        home.map(|home| home.join(trimmed))
            .unwrap_or_else(|| PathBuf::from(trimmed))
    };
    let label = scan_root_label(trimmed);
    let path = normalize_scan_root_path(&path.to_string_lossy());
    ScanRootSetting {
        id: if matches!(trimmed, "Desktop" | "Downloads" | "Documents") {
            format!("default-{}", trimmed.to_lowercase())
        } else {
            scan_root_id(&path)
        },
        path,
        label,
        enabled,
        created_at: DEFAULT_SCAN_ROOT_CREATED_AT.to_string(),
    }
}

fn push_unique_scan_root(roots: &mut Vec<ScanRootSetting>, root: ScanRootSetting) {
    let normalized_path = root.path.to_lowercase();
    if roots
        .iter()
        .any(|existing| existing.path.to_lowercase() == normalized_path)
    {
        return;
    }
    roots.push(root);
}

fn normalize_scan_root_path(path: &str) -> String {
    let normalized = path.trim().replace('\\', "/");
    let without_trailing = normalized.trim_end_matches('/');
    if without_trailing.is_empty() {
        normalized
    } else {
        without_trailing.to_string()
    }
}

fn scan_root_label(path: &str) -> String {
    let normalized = normalize_scan_root_path(path);
    normalized
        .split('/')
        .filter(|segment| !segment.is_empty())
        .last()
        .unwrap_or(&normalized)
        .to_string()
}

fn scan_root_id(path: &str) -> String {
    let slug = normalize_scan_root_path(path)
        .to_lowercase()
        .trim_start_matches(|character: char| character.is_ascii_alphabetic() || character == ':')
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&character) {
                character
            } else {
                '-'
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string();

    format!("scan-root-{}", if slug.is_empty() { "root" } else { &slug })
}

fn looks_absolute_path(path: &str) -> bool {
    Path::new(path).is_absolute()
        || path.starts_with('/')
        || path.starts_with('\\')
        || path.as_bytes().get(0..3).is_some_and(|prefix| {
            prefix[0].is_ascii_alphabetic()
                && prefix[1] == b':'
                && (prefix[2] == b'/' || prefix[2] == b'\\')
        })
}

#[derive(Debug, Error)]
pub enum SettingsError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error("autostart error: {0}")]
    Autostart(String),
}

pub trait LaunchAtLoginController {
    fn enable(&self) -> Result<(), String>;
    fn disable(&self) -> Result<(), String>;
    fn is_enabled(&self) -> Result<bool, String>;
}

impl LaunchAtLoginController for AutoLaunchManager {
    fn enable(&self) -> Result<(), String> {
        AutoLaunchManager::enable(self).map_err(|error| error.to_string())
    }

    fn disable(&self) -> Result<(), String> {
        AutoLaunchManager::disable(self).map_err(|error| error.to_string())
    }

    fn is_enabled(&self) -> Result<bool, String> {
        AutoLaunchManager::is_enabled(self).map_err(|error| error.to_string())
    }
}

pub fn save_app_settings_with_launch_at_login(
    db: &Database,
    settings: &AppSettings,
    launch_at_login: &impl LaunchAtLoginController,
) -> Result<AppSettings, SettingsError> {
    let current_settings = get_app_settings(db)?;
    if current_settings.launch_at_login != settings.launch_at_login {
        if settings.launch_at_login {
            launch_at_login.enable().map_err(SettingsError::Autostart)?;
        } else {
            launch_at_login
                .disable()
                .map_err(SettingsError::Autostart)?;
        }
    }

    let normalized = normalized_app_settings(settings);
    save_app_settings(db, &normalized)?;
    Ok(normalized)
}

pub fn sync_launch_at_login_from_system(
    db: &Database,
    settings: &AppSettings,
    launch_at_login: &impl LaunchAtLoginController,
) -> Result<AppSettings, SettingsError> {
    let system_launch_at_login = launch_at_login
        .is_enabled()
        .map_err(SettingsError::Autostart)?;
    if settings.launch_at_login == system_launch_at_login {
        return Ok(settings.clone());
    }

    let mut synced_settings = settings.clone();
    synced_settings.launch_at_login = system_launch_at_login;
    save_app_settings(db, &synced_settings)?;
    Ok(synced_settings)
}

#[tauri::command]
pub fn get_settings(db: State<'_, Database>) -> Result<AppSettings, String> {
    get_app_settings(&db).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn save_settings<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    watcher_manager: State<'_, FileWatcherManager>,
    settings: AppSettings,
) -> Result<AppSettings, String> {
    let launch_at_login = app.autolaunch();
    let saved = save_app_settings_with_launch_at_login(&db, &settings, &*launch_at_login)
        .map_err(|error| error.to_string())?;

    if let Err(error) = reload_file_watcher_for_settings(app.clone(), &watcher_manager, &saved) {
        emit_file_watcher_error(&app, error.clone());
        eprintln!("File watcher reload failed after settings save (non-fatal): {error}");
    }

    Ok(saved)
}
