use crate::db::{Database, DbError, InsertFileRequest};
use crate::path_filter::is_ignored_dir_name;
use jwalk::{ClientState, DirEntry, WalkDir};
use serde::Serialize;
use std::{
    ffi::OsStr,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime, State};
use thiserror::Error;

const SCAN_BATCH_SIZE: usize = 500;
const SCAN_EMIT_INTERVAL: Duration = Duration::from_millis(200);
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
    pub ctime: i64,
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

#[derive(Clone)]
pub struct ScanCancellationToken(pub Arc<AtomicBool>);

#[tauri::command]
pub async fn scan_directory<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    cancel: State<'_, ScanCancellationToken>,
    path: String,
) -> Result<ScanSummary, String> {
    let db = db.inner().clone();
    cancel.0.store(false, Ordering::Relaxed);
    let cancel_flag = Arc::clone(&cancel.0);
    tauri::async_runtime::spawn_blocking(move || {
        scan_directory_blocking(app, db, PathBuf::from(path), cancel_flag)
    })
    .await
    .map_err(|error| ScanError::Join(error.to_string()).to_string())?
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn cancel_scan(cancel: State<'_, ScanCancellationToken>) {
    cancel.0.store(true, Ordering::Relaxed);
}

fn scan_directory_blocking<R: Runtime>(
    app: AppHandle<R>,
    db: Database,
    root: PathBuf,
    cancel_flag: Arc<AtomicBool>,
) -> Result<ScanSummary, ScanError> {
    validate_root(&root)?;

    let started_at = Instant::now();
    let root_label = normalize_path(&root);
    let skipped = Arc::new(AtomicU64::new(0));
    let skipped_for_filter = Arc::clone(&skipped);
    let mut counters = ScanCounters::default();
    let mut batch = ScanBatchBuffer::new(started_at);

    app.emit(
        SCAN_STARTED_EVENT,
        ScanStartedPayload {
            root: root_label.clone(),
            batch_size: SCAN_BATCH_SIZE,
        },
    )?;

    let walker = WalkDir::new(&root)
        .skip_hidden(true)
        .follow_links(false)
        .process_read_dir(move |_depth, _path, _state, children| {
            children.retain(|entry_result| match entry_result {
                Ok(entry)
                    if entry.file_type().is_dir() && is_ignored_dir_name(entry.file_name()) =>
                {
                    skipped_for_filter.fetch_add(1, Ordering::Relaxed);
                    false
                }
                _ => true,
            });
        });

    for entry_result in walker {
        if is_scan_cancelled(&cancel_flag) {
            break;
        }

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

        if batch.should_flush(Instant::now()) {
            let context = BatchEmitContext {
                app: &app,
                db: &db,
                root: &root_label,
                counters: &counters,
                started_at,
            };
            batch.flush(&context, skipped.load(Ordering::Relaxed))?;
        }
    }

    if !batch.is_empty() {
        let context = BatchEmitContext {
            app: &app,
            db: &db,
            root: &root_label,
            counters: &counters,
            started_at,
        };
        batch.flush(&context, skipped.load(Ordering::Relaxed))?;
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

struct BatchEmitContext<'a, R: Runtime> {
    app: &'a AppHandle<R>,
    db: &'a Database,
    root: &'a str,
    counters: &'a ScanCounters,
    started_at: Instant,
}

struct ScanBatchBuffer {
    entries: Vec<ScannedEntry>,
    batch_index: u64,
    last_emit_at: Instant,
}

impl ScanBatchBuffer {
    fn new(started_at: Instant) -> Self {
        Self {
            entries: Vec::with_capacity(SCAN_BATCH_SIZE),
            batch_index: 0,
            last_emit_at: started_at,
        }
    }

    fn push(&mut self, entry: ScannedEntry) {
        self.entries.push(entry);
    }

    fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn should_flush(&self, now: Instant) -> bool {
        !self.entries.is_empty()
            && (self.entries.len() >= SCAN_BATCH_SIZE
                || now.duration_since(self.last_emit_at) >= SCAN_EMIT_INTERVAL)
    }

    fn flush<R: Runtime>(
        &mut self,
        context: &BatchEmitContext<'_, R>,
        skipped: u64,
    ) -> Result<(), ScanError> {
        if self.entries.is_empty() {
            return Ok(());
        }

        let progress =
            progress_payload(context.root, context.counters, skipped, context.started_at);
        let entries = std::mem::take(&mut self.entries);
        context.db.insert_files(
            &entries
                .iter()
                .map(scanned_entry_to_insert_request)
                .collect::<Vec<_>>(),
        )?;

        context.app.emit(
            SCAN_BATCH_EVENT,
            ScanBatchPayload {
                root: context.root.to_string(),
                batch_index: self.batch_index,
                entries,
                progress: progress.clone(),
            },
        )?;
        context.app.emit(SCAN_PROGRESS_EVENT, progress)?;

        self.batch_index += 1;
        self.last_emit_at = Instant::now();
        self.entries.reserve(SCAN_BATCH_SIZE);
        Ok(())
    }
}

fn scanned_entry_to_insert_request(entry: &ScannedEntry) -> InsertFileRequest {
    InsertFileRequest {
        id: entry.path.clone(),
        path: entry.path.clone(),
        name: entry.name.clone(),
        extension: entry.extension.clone(),
        size: i64::try_from(entry.size).unwrap_or(i64::MAX),
        mtime: entry.mtime,
        ctime: entry.ctime,
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
    let mtime = modified_unix_seconds(&metadata);

    Ok(ScannedEntry {
        path: normalize_path(&path),
        name: entry.file_name().to_string_lossy().into_owned(),
        extension: path
            .extension()
            .and_then(OsStr::to_str)
            .unwrap_or_default()
            .to_ascii_lowercase(),
        size: if is_dir { 0 } else { metadata.len() },
        mtime,
        ctime: metadata
            .created()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_secs() as i64)
            .unwrap_or(mtime),
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

fn is_scan_cancelled(cancel_flag: &AtomicBool) -> bool {
    cancel_flag.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{ffi::OsStr, sync::atomic::AtomicBool, time::Duration};

    #[test]
    fn should_skip_dir_matches_case_insensitive_generated_variants() {
        assert!(is_ignored_dir_name(OsStr::new("Node_Modules")));
        assert!(is_ignored_dir_name(OsStr::new("node_modules.cache")));
        assert!(is_ignored_dir_name(OsStr::new(".git-worktree")));
        assert!(is_ignored_dir_name(OsStr::new("System Volume Information")));
        assert!(!is_ignored_dir_name(OsStr::new("client-documents")));
    }

    #[test]
    fn scan_cancellation_flag_reports_requested_cancel() {
        let cancel_flag = AtomicBool::new(true);

        assert!(is_scan_cancelled(&cancel_flag));
    }

    #[test]
    fn scan_batch_buffer_flushes_after_emit_interval() {
        let started_at = Instant::now();
        let mut buffer = ScanBatchBuffer::new(started_at);

        assert!(!buffer.should_flush(started_at + Duration::from_millis(250)));

        buffer.push(test_scanned_entry(1));

        assert!(!buffer.should_flush(started_at + Duration::from_millis(199)));
        assert!(buffer.should_flush(started_at + SCAN_EMIT_INTERVAL));
    }

    #[test]
    fn scan_batch_buffer_flushes_when_batch_is_full() {
        let started_at = Instant::now();
        let mut buffer = ScanBatchBuffer::new(started_at);

        for index in 0..SCAN_BATCH_SIZE {
            buffer.push(test_scanned_entry(index));
        }

        assert!(buffer.should_flush(started_at + Duration::from_millis(1)));
    }

    fn test_scanned_entry(index: usize) -> ScannedEntry {
        ScannedEntry {
            path: format!("/tmp/file-{index}.txt"),
            name: format!("file-{index}.txt"),
            extension: "txt".to_string(),
            size: 1,
            mtime: 0,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        }
    }
}
