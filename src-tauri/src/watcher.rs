use crate::{
    path_filter::is_ignored_dir_name,
    settings::{AppSettings, ScanRootSetting},
};
use notify::{
    event::{ModifyKind, RenameMode},
    recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use serde::Serialize;
use std::{
    path::{Path, PathBuf},
    sync::{
        mpsc::{self, Receiver, RecvTimeoutError},
        Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
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
    #[error("watcher state lock poisoned")]
    StateLock,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWatchEvent {
    pub event_type: String,
    pub paths: Vec<String>,
    pub stale_paths: Vec<String>,
    pub upsert_paths: Vec<String>,
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

#[derive(Default)]
pub struct FileWatcherManager {
    session: Mutex<Option<WatcherSession>>,
}

struct WatcherSession {
    roots: Vec<PathBuf>,
    shutdown: Option<Box<dyn FnOnce() + Send + 'static>>,
}

impl WatcherSession {
    fn new(roots: Vec<PathBuf>, shutdown: impl FnOnce() + Send + 'static) -> Self {
        Self {
            roots,
            shutdown: Some(Box::new(shutdown)),
        }
    }

    fn detach(mut self) {
        self.shutdown.take();
    }
}

impl Drop for WatcherSession {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            shutdown();
        }
    }
}

impl FileWatcherManager {
    fn restart<R: Runtime>(
        &self,
        app: AppHandle<R>,
        paths: Vec<PathBuf>,
    ) -> Result<bool, WatcherError> {
        let roots = normalize_watch_roots(paths)?;
        if roots.is_empty() {
            let changed = self.restart_with_roots(Vec::new(), |_| unreachable!())?;
            if changed {
                emit_watcher_ready(&app, Vec::new())?;
            }
            return Ok(changed);
        }

        self.restart_with_roots(roots, |roots| start_watcher_session(app, roots))
    }

    fn restart_with_roots(
        &self,
        roots: Vec<PathBuf>,
        start: impl FnOnce(Vec<PathBuf>) -> Result<WatcherSession, WatcherError>,
    ) -> Result<bool, WatcherError> {
        let mut session = self.session.lock().map_err(|_| WatcherError::StateLock)?;
        if session
            .as_ref()
            .is_some_and(|current| current.roots == roots)
        {
            return Ok(false);
        }

        if roots.is_empty() {
            *session = None;
            return Ok(true);
        }

        let next = start(roots)?;
        *session = Some(next);
        Ok(true)
    }

    pub fn active_roots(&self) -> Result<Vec<PathBuf>, String> {
        self.session
            .lock()
            .map(|session| {
                session
                    .as_ref()
                    .map(|session| session.roots.clone())
                    .unwrap_or_default()
            })
            .map_err(|_| WatcherError::StateLock.to_string())
    }
}

pub fn setup_file_watcher<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    setup_file_watcher_inner(app, paths).map_err(|error| error.to_string())
}

pub fn reload_file_watcher_for_settings<R: Runtime>(
    app: AppHandle<R>,
    manager: &FileWatcherManager,
    settings: &AppSettings,
) -> Result<bool, String> {
    let paths = existing_watch_paths_from_default_scan_folders(&settings.default_scan_folders);
    reload_file_watcher(app, manager, paths)
}

pub fn reload_file_watcher<R: Runtime>(
    app: AppHandle<R>,
    manager: &FileWatcherManager,
    paths: Vec<PathBuf>,
) -> Result<bool, String> {
    manager
        .restart(app, paths)
        .map_err(|error| error.to_string())
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

pub fn existing_watch_paths_from_default_scan_folders(folders: &[ScanRootSetting]) -> Vec<PathBuf> {
    watch_paths_from_default_scan_folders(folders)
        .into_iter()
        .filter(|path| path.exists())
        .collect()
}

pub fn emit_file_watcher_error<R: Runtime>(app: &AppHandle<R>, message: String) {
    let _ = app.emit(WATCHER_ERROR_EVENT_NAME, WatcherErrorEvent { message });
}

fn setup_file_watcher_inner<R: Runtime>(
    app: AppHandle<R>,
    paths: Vec<PathBuf>,
) -> Result<(), WatcherError> {
    let roots = normalize_watch_roots(paths)?;
    if roots.is_empty() {
        emit_watcher_ready(&app, Vec::new())?;
        return Ok(());
    }
    let session = start_watcher_session(app, roots)?;
    session.detach();
    Ok(())
}

fn start_watcher_session<R: Runtime>(
    app: AppHandle<R>,
    roots: Vec<PathBuf>,
) -> Result<WatcherSession, WatcherError> {
    let root_labels = roots
        .iter()
        .map(|path| normalize_path(path))
        .collect::<Vec<_>>();
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let mut watcher = recommended_watcher(move |event| {
        let _ = tx.send(event);
    })?;

    for root in &roots {
        watcher.watch(root, RecursiveMode::Recursive)?;
    }

    emit_watcher_ready(&app, root_labels)?;

    let handle = thread::Builder::new()
        .name("zen-canvas-file-watcher".to_string())
        .spawn(move || run_watcher_loop(app, watcher, rx, stop_rx))
        .map_err(WatcherError::Thread)?;

    Ok(WatcherSession::new(roots, move || {
        stop_watcher(stop_tx, handle)
    }))
}

fn stop_watcher(stop_tx: mpsc::Sender<()>, handle: JoinHandle<()>) {
    let _ = stop_tx.send(());
    let _ = handle.join();
}

fn emit_watcher_ready<R: Runtime>(
    app: &AppHandle<R>,
    roots: Vec<String>,
) -> Result<(), WatcherError> {
    app.emit(
        WATCHER_READY_EVENT_NAME,
        WatcherReadyEvent {
            roots,
            recursive: true,
        },
    )?;
    Ok(())
}

fn run_watcher_loop(
    app: AppHandle<impl Runtime>,
    _watcher: RecommendedWatcher,
    rx: Receiver<notify::Result<Event>>,
    stop_rx: Receiver<()>,
) {
    loop {
        if stop_rx.try_recv().is_ok() {
            break;
        }

        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(event) => match event {
                Ok(event) => {
                    if let Some(payload) = event_to_payload(event) {
                        let _ = app.emit(FILE_EVENT_NAME, payload);
                    }
                }
                Err(error) => emit_file_watcher_error(&app, error.to_string()),
            },
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn event_to_payload(event: Event) -> Option<FileWatchEvent> {
    if matches!(event.kind, EventKind::Access(_)) {
        return None;
    }

    let paths = normalize_event_paths(&event.paths);

    if paths.is_empty() {
        return None;
    }

    let (stale_paths, upsert_paths) = route_event_paths(&event.kind, &event.paths);

    Some(FileWatchEvent {
        event_type: event_type(&event.kind).to_string(),
        paths,
        stale_paths,
        upsert_paths,
        timestamp_ms: current_timestamp_ms(),
    })
}

fn route_event_paths(kind: &EventKind, paths: &[PathBuf]) -> (Vec<String>, Vec<String>) {
    match kind {
        EventKind::Remove(_) => (normalize_event_paths(paths), Vec::new()),
        EventKind::Create(_) => (Vec::new(), normalize_event_paths(paths)),
        EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => {
            if paths.len() >= 2 {
                (
                    normalize_event_paths(&paths[0..1]),
                    normalize_event_paths(&paths[1..2]),
                )
            } else {
                (Vec::new(), normalize_event_paths(paths))
            }
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::From)) => {
            (normalize_event_paths(paths), Vec::new())
        }
        EventKind::Modify(ModifyKind::Name(RenameMode::To)) => {
            (Vec::new(), normalize_event_paths(paths))
        }
        EventKind::Modify(ModifyKind::Name(_)) | EventKind::Modify(_) | EventKind::Any => {
            (Vec::new(), normalize_event_paths(paths))
        }
        EventKind::Access(_) | EventKind::Other => (Vec::new(), Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::settings::ScanRootSetting;
    use notify::event::{AccessKind, EventAttributes, RenameMode};
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

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
    fn file_watcher_manager_restarts_when_roots_change() {
        let manager = FileWatcherManager::default();
        let starts = Arc::new(AtomicUsize::new(0));
        let shutdowns = Arc::new(AtomicUsize::new(0));

        restart_test_session(&manager, "/tmp/root-a", &starts, &shutdowns);
        manager
            .restart_with_roots(vec![PathBuf::from("/tmp/root-a")], |_| {
                panic!("unchanged roots should not restart")
            })
            .expect("same roots");
        restart_test_session(&manager, "/tmp/root-b", &starts, &shutdowns);

        assert_eq!(starts.load(Ordering::SeqCst), 2);
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);

        drop(manager);
        assert_eq!(shutdowns.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn file_watcher_manager_stops_when_roots_become_empty() {
        let manager = FileWatcherManager::default();
        let starts = Arc::new(AtomicUsize::new(0));
        let shutdowns = Arc::new(AtomicUsize::new(0));

        restart_test_session(&manager, "/tmp/root-a", &starts, &shutdowns);
        manager
            .restart_with_roots(Vec::new(), |_| panic!("empty roots should not start"))
            .expect("empty roots");

        assert_eq!(
            manager.active_roots().expect("active roots"),
            Vec::<PathBuf>::new()
        );
        assert_eq!(starts.load(Ordering::SeqCst), 1);
        assert_eq!(shutdowns.load(Ordering::SeqCst), 1);
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

    #[test]
    fn event_to_payload_splits_rename_old_and_new_paths() {
        let event = Event {
            kind: EventKind::Modify(ModifyKind::Name(RenameMode::Both)),
            paths: vec![
                PathBuf::from("/Users/zen/Documents/old.pdf"),
                PathBuf::from("/Users/zen/Documents/new.pdf"),
            ],
            attrs: EventAttributes::new(),
        };

        let payload = event_to_payload(event).expect("rename payload");

        assert_eq!(payload.event_type, "renamed");
        assert_eq!(payload.stale_paths, vec!["/Users/zen/Documents/old.pdf"]);
        assert_eq!(payload.upsert_paths, vec!["/Users/zen/Documents/new.pdf"]);
        assert_eq!(
            payload.paths,
            vec![
                "/Users/zen/Documents/old.pdf".to_string(),
                "/Users/zen/Documents/new.pdf".to_string()
            ]
        );
    }

    #[test]
    fn event_to_payload_routes_delete_and_create_paths() {
        let deleted = event_to_payload(Event {
            kind: EventKind::Remove(notify::event::RemoveKind::File),
            paths: vec![PathBuf::from("/Users/zen/Documents/deleted.pdf")],
            attrs: EventAttributes::new(),
        })
        .expect("delete payload");
        let created = event_to_payload(Event {
            kind: EventKind::Create(notify::event::CreateKind::File),
            paths: vec![PathBuf::from("/Users/zen/Documents/created.pdf")],
            attrs: EventAttributes::new(),
        })
        .expect("create payload");

        assert_eq!(
            deleted.stale_paths,
            vec!["/Users/zen/Documents/deleted.pdf"]
        );
        assert!(deleted.upsert_paths.is_empty());
        assert_eq!(
            created.upsert_paths,
            vec!["/Users/zen/Documents/created.pdf"]
        );
        assert!(created.stale_paths.is_empty());
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

    fn restart_test_session(
        manager: &FileWatcherManager,
        root: &str,
        starts: &Arc<AtomicUsize>,
        shutdowns: &Arc<AtomicUsize>,
    ) {
        let starts = Arc::clone(starts);
        let shutdowns = Arc::clone(shutdowns);
        manager
            .restart_with_roots(vec![PathBuf::from(root)], move |roots| {
                starts.fetch_add(1, Ordering::SeqCst);
                Ok(WatcherSession::new(roots, move || {
                    shutdowns.fetch_add(1, Ordering::SeqCst);
                }))
            })
            .expect("restart test session");
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

fn normalize_event_paths(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| !is_ignored_path(path))
        .map(|path| normalize_path(path))
        .collect()
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
