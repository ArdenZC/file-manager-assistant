use crate::{path_filter::is_ignored_dir_name, settings::ScanRootSetting};
use notify::{
    event::ModifyKind, recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode,
    Watcher,
};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::mpsc::{self, Receiver},
    thread,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime};
use thiserror::Error;

const FILE_EVENT_NAME: &str = "fs-event";
const WATCHER_READY_EVENT_NAME: &str = "fs-watcher-ready";
const WATCHER_ERROR_EVENT_NAME: &str = "fs-watcher-error";

#[derive(Debug, Error)]
enum WatcherError {
    #[error("watch path does not exist: {0}")]
    MissingPath(String),
    #[error("watch path is not a directory: {0}")]
    NotDirectory(String),
    #[error("notify error: {0}")]
    Notify(#[from] notify::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("tauri emit error: {0}")]
    Tauri(#[from] tauri::Error),
    #[error("failed to start watcher thread: {0}")]
    Thread(std::io::Error),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWatchEvent {
    pub event_type: String,
    pub paths: Vec<String>,
    pub timestamp_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherReadyEvent {
    pub roots: Vec<String>,
    pub recursive: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatcherErrorEvent {
    pub message: String,
}

pub fn setup_file_watcher<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    setup_file_watcher_inner(app, paths).map_err(|error| error.to_string())
}

pub fn watch_paths_from_default_scan_folders(folders: &[ScanRootSetting]) -> Vec<PathBuf> {
    folders
        .iter()
        .filter(|root| root.enabled)
        .map(|root| root.path.trim())
        .filter(|path| !path.is_empty() && looks_absolute_path(path))
        .map(PathBuf::from)
        .collect()
}

fn setup_file_watcher_inner<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<PathBuf>,
) -> Result<(), WatcherError> {
    let roots = normalize_watch_roots(paths)?;
    let root_labels = roots
        .iter()
        .map(|path| normalize_path(path))
        .collect::<Vec<_>>();
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();

    let mut watcher = recommended_watcher(move |event| {
        let _ = tx.send(event);
    })?;

    for root in &roots {
        watcher.watch(root, RecursiveMode::Recursive)?;
    }

    app.emit(
        WATCHER_READY_EVENT_NAME,
        WatcherReadyEvent {
            roots: root_labels,
            recursive: true,
        },
    )?;

    thread::Builder::new()
        .name("zen-canvas-file-watcher".to_string())
        .spawn(move || run_watcher_loop(app, watcher, rx))
        .map_err(WatcherError::Thread)?;

    Ok(())
}

fn run_watcher_loop(
    app: AppHandle<impl Runtime>,
    _watcher: RecommendedWatcher,
    rx: Receiver<notify::Result<Event>>,
) {
    for event in rx {
        match event {
            Ok(event) => {
                if let Some(payload) = event_to_payload(event) {
                    let _ = app.emit(FILE_EVENT_NAME, payload);
                }
            }
            Err(error) => {
                let _ = app.emit(
                    WATCHER_ERROR_EVENT_NAME,
                    WatcherErrorEvent {
                        message: error.to_string(),
                    },
                );
            }
        }
    }
}

fn event_to_payload(event: Event) -> Option<FileWatchEvent> {
    if matches!(event.kind, EventKind::Access(_)) {
        return None;
    }

    let paths = event
        .paths
        .into_iter()
        .filter(|path| !is_ignored_path(path))
        .map(|path| normalize_path(&path))
        .collect::<Vec<_>>();

    if paths.is_empty() {
        return None;
    }

    Some(FileWatchEvent {
        event_type: event_type(&event.kind).to_string(),
        paths,
        timestamp_ms: current_timestamp_ms(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ScanRootSetting;
    use notify::event::{AccessKind, EventAttributes};

    #[test]
    fn watch_paths_follow_enabled_absolute_scan_root_settings() {
        let folders = vec![
            scan_root("downloads", "/Users/zen/Downloads", true),
            scan_root("projects", "/Volumes/Work/Projects", true),
            scan_root("archive", "/Volumes/Archive", false),
        ];

        let paths = watch_paths_from_default_scan_folders(&folders);

        assert_eq!(
            paths,
            vec![
                PathBuf::from("/Users/zen/Downloads"),
                PathBuf::from("/Volumes/Work/Projects")
            ]
        );
    }

    #[test]
    fn watch_paths_ignore_disabled_empty_and_relative_roots() {
        let folders = vec![
            scan_root("downloads", "/Users/zen/Downloads", false),
            scan_root("empty", "", true),
            scan_root("relative", "Downloads", true),
        ];

        let paths = watch_paths_from_default_scan_folders(&folders);

        assert!(paths.is_empty());
    }

    #[test]
    fn event_to_payload_ignores_access_events() {
        let event = Event {
            kind: EventKind::Access(AccessKind::Read),
            paths: vec![PathBuf::from("/Users/zen/Documents/report.pdf")],
            attrs: EventAttributes::new(),
        };

        assert!(event_to_payload(event).is_none());
    }

    fn scan_root(id: &str, path: &str, enabled: bool) -> ScanRootSetting {
        ScanRootSetting {
            id: id.to_string(),
            path: path.to_string(),
            label: id.to_string(),
            enabled,
            created_at: "2026-06-22T00:00:00.000Z".to_string(),
        }
    }
}

fn event_type(kind: &EventKind) -> &'static str {
    match kind {
        EventKind::Create(_) => "created",
        EventKind::Remove(_) => "deleted",
        EventKind::Modify(ModifyKind::Name(_)) => "renamed",
        EventKind::Modify(_) => "modified",
        EventKind::Access(_) => "accessed",
        EventKind::Any => "changed",
        EventKind::Other => "other",
    }
}

fn normalize_watch_roots(paths: Vec<PathBuf>) -> Result<Vec<PathBuf>, WatcherError> {
    let mut roots = Vec::new();

    for path in paths {
        if !path.exists() {
            return Err(WatcherError::MissingPath(normalize_path(&path)));
        }
        if !path.is_dir() {
            return Err(WatcherError::NotDirectory(normalize_path(&path)));
        }

        let canonical = path.canonicalize()?;
        if roots.iter().any(|root| root == &canonical) {
            continue;
        }
        roots.push(canonical);
    }

    Ok(roots)
}

fn is_ignored_path(path: &Path) -> bool {
    path.components()
        .any(|component| is_ignored_dir_name(component.as_os_str()))
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
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

fn current_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}
