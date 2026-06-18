use crate::db::{Database, DbError, InsertFileRequest};
use jwalk::{ClientState, DirEntry, WalkDir};
use serde::Serialize;
use std::{
    collections::HashSet,
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, OnceLock,
    },
    time::{Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime, State};
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
    #[error("metadata error at {path}: {source}")]
    Metadata {
        path: String,
        #[source]
        source: jwalk::Error,
    },
    #[error("event emit failed: {0}")]
    Emit(#[from] tauri::Error),
    #[error("database insert failed: {0}")]
    Database(#[from] DbError),
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
pub async fn scan_directory<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    path: String,
) -> Result<ScanSummary, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        scan_directory_blocking(app, db, PathBuf::from(path))
    })
    .await
    .map_err(|error| ScanError::Join(error.to_string()).to_string())?
    .map_err(|error| error.to_string())
}

fn scan_directory_blocking<R: Runtime>(
    app: AppHandle<R>,
    db: Database,
    root: PathBuf,
) -> Result<ScanSummary, ScanError> {
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
            Ok(entry) => match entry_to_payload(&entry) {
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
            },
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
                &db,
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
            &db,
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
    db: &Database,
    root: &str,
    batch: &mut Vec<ScannedEntry>,
    batch_index: &mut u64,
    counters: &ScanCounters,
    skipped: u64,
    started_at: Instant,
) -> Result<(), ScanError> {
    let progress = progress_payload(root, counters, skipped, started_at);
    let entries = std::mem::take(batch);
    db.insert_files(
        &entries
            .iter()
            .map(scanned_entry_to_insert_request)
            .collect::<Vec<_>>(),
    )?;

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

fn scanned_entry_to_insert_request(entry: &ScannedEntry) -> InsertFileRequest {
    InsertFileRequest {
        id: entry.path.clone(),
        path: entry.path.clone(),
        name: entry.name.clone(),
        extension: entry.extension.clone(),
        size: i64::try_from(entry.size).unwrap_or(i64::MAX),
        mtime: entry.mtime,
        is_dir: entry.is_dir,
        state_code: i64::from(entry.state_code),
    }
}

fn emit_scan_error(
    app: &AppHandle<impl Runtime>,
    root: &str,
    error: ScanError,
) -> Result<(), ScanError> {
    let (path, message) = match error {
        ScanError::Metadata { path, source } => (path, source.to_string()),
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

fn entry_to_payload<C: ClientState>(entry: &DirEntry<C>) -> Result<ScannedEntry, ScanError> {
    let path = entry.path();
    let is_dir = entry.file_type().is_dir();
    let metadata = entry.metadata().map_err(|source| ScanError::Metadata {
        path: normalize_path(&path),
        source,
    })?;

    Ok(ScannedEntry {
        path: normalize_path(&path),
        name: entry.file_name().to_string_lossy().into_owned(),
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
    let lower = lower.as_str();

    skip_dir_names().contains(lower) || has_generated_dir_variant(lower)
}

fn skip_dir_names() -> &'static HashSet<&'static str> {
    static SKIP_DIR_NAMES: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SKIP_DIR_NAMES.get_or_init(|| {
        [
            ".git",
            ".hg",
            ".svn",
            ".idea",
            ".vscode",
            ".cache",
            ".parcel-cache",
            ".turbo",
            ".next",
            ".nuxt",
            ".venv",
            "__pycache__",
            "node_modules",
            "target",
            "dist",
            "build",
            "coverage",
            "vendor",
            "venv",
            "pods",
            "deriveddata",
            "appdata",
            "library",
            "system volume information",
            "$recycle.bin",
            "windows",
            "program files",
            "program files (x86)",
            "programdata",
            "$windows.~bt",
            "$winreagent",
            "recovery",
        ]
        .into_iter()
        .collect()
    })
}

fn has_generated_dir_variant(lower: &str) -> bool {
    const VARIANT_BASES: &[&str] = &[".git", ".cache", "__pycache__", "node_modules"];
    VARIANT_BASES.iter().any(|base| {
        lower
            .strip_prefix(base)
            .is_some_and(|suffix| matches!(suffix.as_bytes().first(), Some(b'.' | b'-' | b'_')))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ffi::OsStr;

    #[test]
    fn should_skip_dir_matches_case_insensitive_generated_variants() {
        assert!(should_skip_dir(OsStr::new("Node_Modules")));
        assert!(should_skip_dir(OsStr::new("node_modules.cache")));
        assert!(should_skip_dir(OsStr::new(".git-worktree")));
        assert!(should_skip_dir(OsStr::new("System Volume Information")));
        assert!(!should_skip_dir(OsStr::new("client-documents")));
    }
}
