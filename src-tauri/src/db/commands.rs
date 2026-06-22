use super::*;
use crate::file_ops::OperationLogDto;
use tauri::{AppHandle, Runtime, State};

#[tauri::command]
pub fn init_db(db: State<'_, Database>) -> Result<(), String> {
    db.init().map_err(command_error)
}

#[tauri::command]
pub fn insert_file(db: State<'_, Database>, file: InsertFileRequest) -> Result<(), String> {
    db.insert_file(file).map_err(command_error)
}

#[tauri::command]
pub fn remove_files_by_paths(db: State<'_, Database>, paths: Vec<String>) -> Result<usize, String> {
    db.remove_files_by_paths(&paths).map_err(command_error)
}

#[tauri::command]
pub fn upsert_files_by_paths<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    paths: Vec<String>,
) -> Result<usize, String> {
    let db = db.inner();
    let upserted = upsert_files_by_paths_for_db(db, &paths).map_err(command_error)?;
    if let Some(report) = optimize_search_index_after_bulk_upsert(db, upserted) {
        emit_search_index_optimized(&app, &report);
    }
    Ok(upserted)
}

#[tauri::command]
pub fn search_files(
    db: State<'_, Database>,
    query: String,
    limit: Option<u32>,
    scope: Option<LibraryScope>,
) -> Result<Vec<FileRecordDto>, String> {
    match scope.as_ref() {
        Some(scope) => db
            .search_files_in_scope(&query, limit, scope)
            .map_err(command_error),
        None => db.search_files(&query, limit).map_err(command_error),
    }
}

#[tauri::command]
pub fn get_paged_files(
    db: State<'_, Database>,
    limit: Option<u32>,
    offset: Option<u32>,
    query: Option<String>,
    scope: Option<LibraryScope>,
) -> Result<PagedFilesResult, String> {
    match scope.as_ref() {
        Some(scope) => db
            .get_paged_files_in_scope(limit, offset, query.as_deref(), scope)
            .map_err(command_error),
        None => db
            .get_paged_files(limit, offset, query.as_deref())
            .map_err(command_error),
    }
}

#[tauri::command]
pub fn get_stats_summary(
    db: State<'_, Database>,
    scope: Option<LibraryScope>,
) -> Result<StatsSummary, String> {
    match scope.as_ref() {
        Some(scope) => db.get_stats_summary_in_scope(scope).map_err(command_error),
        None => db.get_stats_summary().map_err(command_error),
    }
}

#[tauri::command]
pub fn get_operation_logs(
    db: State<'_, Database>,
    limit: Option<u32>,
) -> Result<Vec<OperationLogDto>, String> {
    db.get_operation_logs(limit).map_err(command_error)
}

#[tauri::command]
pub fn get_user_rules(db: State<'_, Database>) -> Result<Vec<Rule>, String> {
    db.get_user_rules().map_err(command_error)
}

#[tauri::command]
pub fn save_user_rule(db: State<'_, Database>, rule: Rule) -> Result<Rule, String> {
    db.save_user_rule(rule).map_err(command_error)
}

#[tauri::command]
pub fn delete_user_rule(db: State<'_, Database>, id: String) -> Result<bool, String> {
    db.delete_user_rule(&id).map_err(command_error)
}

#[tauri::command]
pub async fn execute_rules_on_inbox(
    db: State<'_, Database>,
    rules: Vec<Rule>,
) -> Result<RuleExecutionSummary, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.execute_rules_on_inbox(rules))
        .await
        .map_err(|error| error.to_string())?
        .map_err(command_error)
}

#[tauri::command]
pub async fn execute_rules_for_paths(
    db: State<'_, Database>,
    paths: Vec<String>,
    rules: Vec<Rule>,
) -> Result<RuleExecutionSummary, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.execute_rules_for_paths(&paths, rules))
        .await
        .map_err(|error| error.to_string())?
        .map_err(command_error)
}

#[tauri::command]
pub async fn execute_rules_for_scope(
    db: State<'_, Database>,
    scope: LibraryScope,
    rules: Vec<Rule>,
) -> Result<RuleExecutionSummary, String> {
    let db = db.inner().clone();
    tauri::async_runtime::spawn_blocking(move || db.execute_rules_for_scope(&scope, rules))
        .await
        .map_err(|error| error.to_string())?
        .map_err(command_error)
}

fn command_error(error: DbError) -> String {
    error.to_string()
}
