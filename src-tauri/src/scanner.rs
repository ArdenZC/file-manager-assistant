use jwalk::WalkDir;
use serde::Serialize;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime};
use thiserror::Error;

const BATCH_SIZE: usize = 1_000;
const SCAN_STARTED_EVENT: &str = "scan-started";
const SCAN_BATCH_EVENT: &str = "scan-batch";
const SCAN_PROGRESS_EVENT: &str = "scan-progress";
const SCAN_COMPLETE_EVENT: &str = "scan-complete";
const SCAN_ERROR_EVENT: &str = "scan-error";

#[derive(Debug, Error)]
enum ScanError {
    #[error("scan root does not exist: {0}")]
    MissingRoot(String),
    #[error("scan root is not a readable file-system path: {0}")]
    InvalidRoot(String),
    #[error("io error at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
    #[error("event emit failed: {0}")]
    Emit(#[from] tauri::Error),
    #[error("scan task failed: {0}")]
    Join(String),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScannedEntry {
    pub path: String,
    pub name: String,
    pub extension: String,
    pub size: u64,
    pub mtime: i64,
    pub is_dir: bool,
    pub state_code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanProgressPayload {
    pub root: String,
    pub scanned: u64,
    pub files: u64,
    pub directories: u64,
    pub skipped: u64,
    pub errors: u64,
    pub elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanStartedPayload {
    pub root: String,
    pub batch_size: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanBatchPayload {
    pub root: String,
    pub batch_index: u64,
    pub entries: Vec<ScannedEntry>,
    pub progress: ScanProgressPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanErrorPayload {
    pub root: String,
    pub path: String,
    pub message: String,
}

pub type ScanSummary = ScanProgressPayload;

#[derive(Default)]
struct ScanCounters {
    scanned: u64,
    files: u64,
    directories: u64,
    errors: u64,
}

#[tauri::command]
pub async fn scan_directory<R: Runtime>(app: AppHandle<R>, path: String) -> Result<ScanSummary, String> {
    tauri::async_runtime::spawn_blocking(move || scan_directory_blocking(app, PathBuf::from(path)))
        .await
        .map_err(|error| ScanError::Join(error.to_string()).to_string())?
        .map_err(|error| error.to_string())
}

fn scan_directory_blocking<R: Runtime>(app: AppHandle<R>, root: PathBuf) -> Result<ScanSummary, ScanError> {
    validate_root(&root)?;

    let started_at = Instant::now();
    let root_label = normalize_path(&root);
    let skipped = Arc::new(AtomicU64::new(0));
    let skipped_for_filter = Arc::clone(&skipped);
    let mut counters = ScanCounters::default();
    let mut batch_index = 0;
    let mut batch = Vec::with_capacity(BATCH_SIZE);

    app.emit(
        SCAN_STARTED_EVENT,
        ScanStartedPayload {
            root: root_label.clone(),
            batch_size: BATCH_SIZE,
        },
    )?;

    let walker = WalkDir::new(&root)
        .skip_hidden(true)
        .follow_links(false)
        .process_read_dir(move |_depth, _path, _state, children| {
            children.retain(|entry_result| match entry_result {
                Ok(entry) if entry.file_type().is_dir() && should_skip_dir(entry.file_name()) => {
                    skipped_for_filter.fetch_add(1, Ordering::Relaxed);
                    false
                }
                _ => true,
            });
        });

    for entry_result in walker {
        match entry_result {
            Ok(entry) => {
                let path = entry.path();
                match entry_to_payload(&path, entry.file_name(), entry.file_type().is_dir()) {
                    Ok(payload) => {
                        counters.scanned += 1;
                        if payload.is_dir {
                            counters.directories += 1;
                        } else {
                            counters.files += 1;
                        }
                        batch.push(payload);
                    }
                    Err(error) => {
                        counters.errors += 1;
                        emit_scan_error(&app, &root_label, error)?;
                    }
                }
            }
            Err(error) => {
                counters.errors += 1;
                app.emit(
                    SCAN_ERROR_EVENT,
                    ScanErrorPayload {
                        root: root_label.clone(),
                        path: root_label.clone(),
                        message: error.to_string(),
                    },
                )?;
            }
        }

        if batch.len() >= BATCH_SIZE {
            emit_batch(
                &app,
                &root_label,
                &mut batch,
                &mut batch_index,
                &counters,
                skipped.load(Ordering::Relaxed),
                started_at,
            )?;
        }
    }

    if !batch.is_empty() {
        emit_batch(
            &app,
            &root_label,
            &mut batch,
            &mut batch_index,
            &counters,
            skipped.load(Ordering::Relaxed),
            started_at,
        )?;
    }

    let summary = progress_payload(
        &root_label,
        &counters,
        skipped.load(Ordering::Relaxed),
        started_at,
    );
    app.emit(SCAN_COMPLETE_EVENT, summary.clone())?;
    Ok(summary)
}

fn emit_batch(
    app: &AppHandle<impl Runtime>,
    root: &str,
    batch: &mut Vec<ScannedEntry>,
    batch_index: &mut u64,
    counters: &ScanCounters,
    skipped: u64,
    started_at: Instant,
) -> Result<(), ScanError> {
    let progress = progress_payload(root, counters, skipped, started_at);
    let entries = std::mem::take(batch);

    app.emit(
        SCAN_BATCH_EVENT,
        ScanBatchPayload {
            root: root.to_string(),
            batch_index: *batch_index,
            entries,
            progress: progress.clone(),
        },
    )?;
    app.emit(SCAN_PROGRESS_EVENT, progress)?;

    *batch_index += 1;
    batch.reserve(BATCH_SIZE);
    Ok(())
}

fn emit_scan_error(app: &AppHandle<impl Runtime>, root: &str, error: ScanError) -> Result<(), ScanError> {
    let (path, message) = match error {
        ScanError::Io { path, source } => (path, source.to_string()),
        other => (root.to_string(), other.to_string()),
    };

    app.emit(
        SCAN_ERROR_EVENT,
        ScanErrorPayload {
            root: root.to_string(),
            path,
            message,
        },
    )?;
    Ok(())
}

fn entry_to_payload(path: &Path, file_name: &OsStr, is_dir: bool) -> Result<ScannedEntry, ScanError> {
    let metadata = std::fs::symlink_metadata(path).map_err(|source| ScanError::Io {
        path: normalize_path(path),
        source,
    })?;

    Ok(ScannedEntry {
        path: normalize_path(path),
        name: file_name.to_string_lossy().into_owned(),
        extension: path
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_ascii_lowercase(),
        size: if is_dir { 0 } else { metadata.len() },
        mtime: modified_unix_seconds(&metadata),
        is_dir,
        state_code: 0,
    })
}

fn progress_payload(
    root: &str,
    counters: &ScanCounters,
    skipped: u64,
    started_at: Instant,
) -> ScanProgressPayload {
    ScanProgressPayload {
        root: root.to_string(),
        scanned: counters.scanned,
        files: counters.files,
        directories: counters.directories,
        skipped,
        errors: counters.errors,
        elapsed_ms: started_at.elapsed().as_millis(),
    }
}

fn validate_root(root: &Path) -> Result<(), ScanError> {
    if !root.exists() {
        return Err(ScanError::MissingRoot(normalize_path(root)));
    }
    if !root.is_dir() && !root.is_file() {
        return Err(ScanError::InvalidRoot(normalize_path(root)));
    }
    Ok(())
}

fn modified_unix_seconds(metadata: &std::fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0)
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn should_skip_dir(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    let lower = name.to_ascii_lowercase();

    matches!(
        lower.as_str(),
        ".git"
            | ".hg"
            | ".svn"
            | ".idea"
            | ".vscode"
            | ".cache"
            | ".parcel-cache"
            | ".turbo"
            | ".next"
            | ".nuxt"
            | ".venv"
            | "__pycache__"
            | "node_modules"
            | "target"
            | "dist"
            | "build"
            | "coverage"
            | "vendor"
            | "venv"
            | "pods"
            | "deriveddata"
            | "appdata"
            | "library"
            | "system volume information"
            | "$recycle.bin"
            | "windows"
            | "program files"
            | "program files (x86)"
            | "programdata"
            | "$windows.~bt"
            | "$winreagent"
            | "recovery"
    )
}
