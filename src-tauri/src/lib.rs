pub mod db;
pub mod file_ops;
pub mod path_filter;
pub mod scanner;
pub mod watcher;

use db::Database;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

pub use db::{
    execute_rules_on_inbox, get_operation_logs, get_paged_files, get_stats_summary, init_db,
    insert_file, search_files, upsert_files_by_paths, FileRecordDto, FileSearchResult,
    InsertFileRequest, PagedFilesResult, Rule, RuleExecutionSummary, StatsSummary,
};
pub use file_ops::{
    execute_moves, move_file, rename_file, restore_moves, ExecuteMovesRequest, ExecuteMovesResult,
    FileOperationResult, OperationLogDto, OperationPreviewRequest, RestoreMovesRequest,
    RestoreMovesResult,
};
pub use scanner::{
    cancel_scan, scan_directory, ScanBatchPayload, ScanCancellationToken, ScanProgressPayload,
    ScanSummary, ScannedEntry,
};
pub use watcher::{setup_file_watcher, FileWatchEvent, WatcherErrorEvent, WatcherReadyEvent};

pub fn database_path<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    Ok(dir.join("zen-canvas.sqlite3"))
}

pub fn open_database<R: Runtime>(app: &AppHandle<R>) -> Result<Database, String> {
    Database::open(database_path(app)?).map_err(|error| error.to_string())
}
