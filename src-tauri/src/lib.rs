pub mod app_control;
pub mod db;
pub mod dedupe;
pub mod file_ops;
pub mod path_filter;
pub mod scanner;
pub mod settings;
pub mod watcher;

use db::Database;
use std::path::PathBuf;
use tauri::{AppHandle, Manager, Runtime};

pub use app_control::{activate_search_result, quit_app, SearchNavigatePayload};
pub use db::{
    delete_user_rule, execute_rules_for_paths, execute_rules_for_scope, execute_rules_on_inbox,
    get_operation_logs, get_operation_previews_for_scope, get_paged_files, get_stats_summary,
    get_user_rules, init_db, insert_file, save_user_rule, search_files, upsert_files_by_paths,
    FileLibraryFilter, FileRecordDto, FileSearchResult, InsertFileRequest, LibraryFilter,
    LibraryScope, OperationPreviewDto, OperationPreviewScopeResult, PagedFilesResult, Rule,
    RuleExecutionMode, RuleExecutionSummary, StatsSummary,
};
pub use file_ops::{
    cancel_operations, execute_moves, move_file, rename_file, restore_moves, ExecuteMovesRequest,
    ExecuteMovesResult, FileOperationResult, OperationCancellationToken, OperationLogDto,
    OperationPreviewRequest, OperationProgressPayload, RestoreMovesRequest, RestoreMovesResult,
};
pub use scanner::{
    cancel_scan, scan_directory, ScanBatchPayload, ScanCancellationToken, ScanProgressPayload,
    ScanSummary, ScannedEntry,
};
pub use settings::{get_app_settings, get_settings, save_app_settings, save_settings, AppSettings};
pub use watcher::{
    setup_file_watcher, FileWatchEvent, FileWatcherManager, WatcherErrorEvent, WatcherReadyEvent,
};

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
