use crate::db::Database;
use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, OpenOptions},
    io,
    path::{Component, Path, PathBuf},
    process::Command as ProcessCommand,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{command, AppHandle, Emitter, Runtime, State};
use thiserror::Error;

pub const OPERATION_PROGRESS_EVENT: &str = "operation-progress";
const OPERATION_PROGRESS_BATCH_SIZE: u64 = 10;
const OPERATION_PROGRESS_EMIT_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Debug, Error)]
enum FileOpError {
    #[error("Source file does not exist.")]
    SourceMissing,
    #[error("Source path is not a regular file.")]
    SourceNotFile,
    #[error("Source and target paths must be absolute.")]
    RelativePath,
    #[error("Target parent directory does not exist.")]
    TargetParentMissing,
    #[error("Target file already exists. Zen Canvas will not overwrite files.")]
    TargetExists,
    #[error("The requested file name is not safe.")]
    UnsafeFileName,
    #[error("Operation rejected because it touches a protected system location: {0}")]
    ProtectedPath(String),
    #[error("Target path contains unsafe parent traversal.")]
    UnsafePathTraversal,
    #[error("File operation failed: {0}")]
    Io(#[from] io::Error),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOperationResult {
    pub operation: String,
    pub source_path: String,
    pub target_path: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ExecuteMovesRequest {
    pub operations: Vec<OperationPreviewRequest>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OperationPreviewRequest {
    pub id: String,
    #[serde(alias = "fileId")]
    pub file_id: String,
    #[serde(alias = "operationType")]
    pub operation_type: String,
    #[serde(alias = "sourcePath")]
    pub source_path: String,
    #[serde(alias = "targetPath")]
    pub target_path: String,
    #[serde(alias = "oldName")]
    pub old_name: String,
    #[serde(alias = "newName")]
    pub new_name: String,
    #[serde(default, alias = "isExecutable")]
    pub is_executable: Option<bool>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct OperationLogDto {
    pub id: String,
    pub batch_id: String,
    pub operation_type: String,
    pub source_path: String,
    pub target_path: String,
    pub old_name: String,
    pub new_name: String,
    pub status: String,
    pub error_message: Option<String>,
    pub created_at: String,
    pub can_undo: bool,
    pub path_before: String,
    pub path_after: String,
    pub name_before: String,
    pub name_after: String,
    pub can_restore: bool,
    pub restored_at: Option<String>,
    pub restore_status: String,
    pub restore_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecuteMovesResult {
    pub logs: Vec<OperationLogDto>,
    #[serde(rename = "updatedFiles")]
    pub updated_files: Vec<serde_json::Value>,
    pub batch_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct RestoreMovesRequest {
    pub logs: Vec<OperationLogDto>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RestoreMovesResult {
    pub logs: Vec<OperationLogDto>,
    pub restored: usize,
    pub failed: usize,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OperationProgressPayload {
    pub kind: String,
    pub batch_id: String,
    pub processed: u64,
    pub total: u64,
    pub current_path: String,
}

#[derive(Clone, Default)]
pub struct OperationCancellationToken(pub Arc<AtomicBool>);

pub trait OperationProgressEmitter {
    fn emit_progress(&self, payload: OperationProgressPayload);
}

struct NoopOperationProgressEmitter;

impl OperationProgressEmitter for NoopOperationProgressEmitter {
    fn emit_progress(&self, _payload: OperationProgressPayload) {}
}

struct TauriOperationProgressEmitter<R: Runtime> {
    app: AppHandle<R>,
}

impl<R: Runtime> TauriOperationProgressEmitter<R> {
    fn new(app: AppHandle<R>) -> Self {
        Self { app }
    }
}

impl<R: Runtime> OperationProgressEmitter for TauriOperationProgressEmitter<R> {
    fn emit_progress(&self, payload: OperationProgressPayload) {
        if let Err(error) = self.app.emit(OPERATION_PROGRESS_EVENT, payload) {
            eprintln!("Operation progress event failed: {error}");
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RevealCommand {
    program: &'static str,
    args: Vec<String>,
}

#[command]
pub fn move_file(source_path: String, target_path: String) -> Result<FileOperationResult, String> {
    let source = validate_source_path(&PathBuf::from(source_path))?;
    let target = validate_target_path(&PathBuf::from(target_path))?;

    ensure_not_protected(&source)?;
    ensure_not_protected(&target)?;
    move_file_no_overwrite(&source, &target)?;

    Ok(FileOperationResult {
        operation: "move".to_string(),
        source_path: normalize_path(&source),
        target_path: normalize_path(&target),
    })
}

#[command]
pub async fn execute_moves<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    cancel: State<'_, OperationCancellationToken>,
    request: ExecuteMovesRequest,
) -> Result<ExecuteMovesResult, String> {
    let db = db.inner().clone();
    cancel.0.store(false, Ordering::Relaxed);
    let cancel_flag = Arc::clone(&cancel.0);
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = TauriOperationProgressEmitter::new(app);
        execute_moves_with_persistence_with_progress(&db, request, cancel_flag, &emitter)
    })
    .await
    .map_err(|error| format!("operation task failed: {error}"))?
}

#[command]
pub fn cancel_operations(cancel: State<'_, OperationCancellationToken>) {
    cancel.0.store(true, Ordering::Relaxed);
}

pub fn execute_moves_with_persistence(
    db: &Database,
    request: ExecuteMovesRequest,
) -> Result<ExecuteMovesResult, String> {
    execute_moves_with_persistence_with_progress(
        db,
        request,
        Arc::new(AtomicBool::new(false)),
        &NoopOperationProgressEmitter,
    )
}

fn execute_moves_with_persistence_with_progress(
    db: &Database,
    request: ExecuteMovesRequest,
    cancel_flag: Arc<AtomicBool>,
    emitter: &impl OperationProgressEmitter,
) -> Result<ExecuteMovesResult, String> {
    let operations = request.operations.clone();
    let mut result = execute_moves_core_with_progress(request, cancel_flag, emitter);

    for (operation, log) in operations.iter().zip(result.logs.iter_mut()) {
        if log.status != "success" {
            continue;
        }

        if let Err(error) = db.update_file_after_successful_operation(
            &operation.file_id,
            &log.path_before,
            &log.path_after,
            &log.name_after,
        ) {
            let warning = format!("file index sync failed: {error}");
            eprintln!("{warning}");
            append_operation_log_error(log, warning);
        }
    }

    db.save_operation_logs(&result.batch_id, &result.logs)
        .map_err(|error| format!("operation completed but failed to persist logs: {error}"))?;
    Ok(result)
}

pub fn execute_moves_core(request: ExecuteMovesRequest) -> ExecuteMovesResult {
    execute_moves_core_with_progress(
        request,
        Arc::new(AtomicBool::new(false)),
        &NoopOperationProgressEmitter,
    )
}

pub fn execute_moves_core_with_progress(
    request: ExecuteMovesRequest,
    cancel_flag: Arc<AtomicBool>,
    emitter: &impl OperationProgressEmitter,
) -> ExecuteMovesResult {
    let batch_id = format!("batch-{}", current_timestamp_ms());
    let created_at = current_timestamp_ms().to_string();
    let total = request.operations.len() as u64;
    let mut progress = OperationProgressBuffer::new("execute", batch_id.clone(), total);
    let mut logs = Vec::with_capacity(request.operations.len());

    for (index, operation) in request.operations.iter().enumerate() {
        let log = if is_operation_cancelled(&cancel_flag) {
            make_canceled_operation_log(&batch_id, &created_at, index, operation)
        } else {
            execute_preview_operation(&batch_id, &created_at, index, operation)
        };
        let current_path = operation.source_path.clone();
        logs.push(log);
        progress.record(emitter, (index + 1) as u64, current_path);
    }

    ExecuteMovesResult {
        logs,
        updated_files: Vec::new(),
        batch_id,
    }
}

#[command]
pub fn reveal_in_folder(path: String) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Path cannot be empty.".to_string());
    }

    let command = build_reveal_command(Path::new(trimmed))?;
    ProcessCommand::new(command.program)
        .args(&command.args)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Failed to reveal path in file manager: {error}"))
}

#[command]
pub fn rename_file(source_path: String, new_name: String) -> Result<FileOperationResult, String> {
    validate_safe_file_name(&new_name)?;
    let source = validate_source_path(&PathBuf::from(source_path))?;
    let parent = source
        .parent()
        .ok_or(FileOpError::TargetParentMissing)
        .map_err(|error| error.to_string())?;
    let target = parent.join(new_name);

    if target.exists() {
        return Err(FileOpError::TargetExists.to_string());
    }

    ensure_not_protected(&source)?;
    ensure_not_protected(&target)?;
    move_file_no_overwrite(&source, &target)?;

    Ok(FileOperationResult {
        operation: "rename".to_string(),
        source_path: normalize_path(&source),
        target_path: normalize_path(&target),
    })
}

fn execute_preview_operation(
    batch_id: &str,
    created_at: &str,
    index: usize,
    operation: &OperationPreviewRequest,
) -> OperationLogDto {
    let status = if operation.is_executable == Some(false) {
        Err("Operation is not executable.".to_string())
    } else {
        match operation.operation_type.as_str() {
            "rename" => rename_file(operation.source_path.clone(), operation.new_name.clone()),
            "move" | "move_rename" => move_file_with_parent_policy(
                operation.source_path.clone(),
                operation.target_path.clone(),
                true,
            ),
            other => Err(format!("Unsupported operation type: {other}")),
        }
    };

    match status {
        Ok(result) => make_operation_log(
            batch_id,
            created_at,
            index,
            operation,
            "success",
            None,
            result.target_path,
        ),
        Err(error) => make_operation_log(
            batch_id,
            created_at,
            index,
            operation,
            if operation.is_executable == Some(false) {
                "skipped"
            } else {
                "failed"
            },
            Some(error),
            operation.target_path.clone(),
        ),
    }
}

#[command]
pub async fn restore_moves<R: Runtime>(
    app: AppHandle<R>,
    db: State<'_, Database>,
    cancel: State<'_, OperationCancellationToken>,
    request: RestoreMovesRequest,
) -> Result<RestoreMovesResult, String> {
    let db = db.inner().clone();
    cancel.0.store(false, Ordering::Relaxed);
    let cancel_flag = Arc::clone(&cancel.0);
    tauri::async_runtime::spawn_blocking(move || {
        let emitter = TauriOperationProgressEmitter::new(app);
        restore_moves_with_persistence_with_progress(&db, request, cancel_flag, &emitter)
    })
    .await
    .map_err(|error| format!("restore task failed: {error}"))?
}

pub fn restore_moves_with_persistence(
    db: &Database,
    request: RestoreMovesRequest,
) -> Result<RestoreMovesResult, String> {
    restore_moves_with_persistence_with_progress(
        db,
        request,
        Arc::new(AtomicBool::new(false)),
        &NoopOperationProgressEmitter,
    )
}

fn restore_moves_with_persistence_with_progress(
    db: &Database,
    request: RestoreMovesRequest,
    cancel_flag: Arc<AtomicBool>,
    emitter: &impl OperationProgressEmitter,
) -> Result<RestoreMovesResult, String> {
    let result = restore_moves_core_with_progress(request, cancel_flag, emitter);
    for log in result
        .logs
        .iter()
        .filter(|log| log.restore_status == "restored")
    {
        if let Err(error) = db.update_file_after_successful_restore(log) {
            eprintln!("restore file index sync failed: {error}");
        }
    }

    db.update_operation_restore_logs(&result.logs)
        .map_err(|error| {
            format!("restore completed but failed to persist restore status: {error}")
        })?;
    Ok(result)
}

pub fn restore_moves_core(request: RestoreMovesRequest) -> RestoreMovesResult {
    restore_moves_core_with_progress(
        request,
        Arc::new(AtomicBool::new(false)),
        &NoopOperationProgressEmitter,
    )
}

pub fn restore_moves_core_with_progress(
    request: RestoreMovesRequest,
    cancel_flag: Arc<AtomicBool>,
    emitter: &impl OperationProgressEmitter,
) -> RestoreMovesResult {
    let mut restored = 0_usize;
    let mut failed = 0_usize;
    let batch_id = restore_progress_batch_id(&request.logs);
    let total = request.logs.len() as u64;
    let mut progress = OperationProgressBuffer::new("restore", batch_id, total);
    let mut logs = Vec::with_capacity(request.logs.len());

    for (index, log) in request.logs.iter().enumerate() {
        let result = if is_operation_cancelled(&cancel_flag) {
            mark_restore_canceled(log)
        } else {
            restore_operation_log(log)
        };
        if result.restore_status == "restored" {
            restored += 1;
        } else if result.restore_status == "failed" {
            failed += 1;
        }
        let current_path = log.path_after.clone();
        logs.push(result);
        progress.record(emitter, (index + 1) as u64, current_path);
    }

    RestoreMovesResult {
        logs,
        restored,
        failed,
    }
}

fn make_canceled_operation_log(
    batch_id: &str,
    created_at: &str,
    index: usize,
    operation: &OperationPreviewRequest,
) -> OperationLogDto {
    make_operation_log(
        batch_id,
        created_at,
        index,
        operation,
        "skipped",
        None,
        operation.target_path.clone(),
    )
}

fn make_operation_log(
    batch_id: &str,
    created_at: &str,
    index: usize,
    operation: &OperationPreviewRequest,
    status: &str,
    error_message: Option<String>,
    actual_target_path: String,
) -> OperationLogDto {
    let success = status == "success";
    OperationLogDto {
        id: format!("{batch_id}-{index}-{}", operation.id),
        batch_id: batch_id.to_string(),
        operation_type: operation.operation_type.clone(),
        source_path: operation.source_path.clone(),
        target_path: actual_target_path.clone(),
        old_name: operation.old_name.clone(),
        new_name: operation.new_name.clone(),
        status: status.to_string(),
        error_message,
        created_at: created_at.to_string(),
        can_undo: success,
        path_before: operation.source_path.clone(),
        path_after: actual_target_path,
        name_before: operation.old_name.clone(),
        name_after: operation.new_name.clone(),
        can_restore: success,
        restored_at: None,
        restore_status: "not_restored".to_string(),
        restore_error: None,
    }
}

fn append_operation_log_error(log: &mut OperationLogDto, message: String) {
    log.error_message = Some(match log.error_message.take() {
        Some(existing) if !existing.trim().is_empty() => format!("{existing}; {message}"),
        _ => message,
    });
}

fn restore_operation_log(log: &OperationLogDto) -> OperationLogDto {
    if log.status != "success" {
        return mark_restore_unavailable(log, "Only successful operations can be restored.");
    }
    if !log.can_restore || log.restore_status == "restored" {
        return mark_restore_unavailable(log, "This operation is no longer restorable.");
    }
    if log.path_before.trim().is_empty() || log.path_after.trim().is_empty() {
        return mark_restore_failed(log, "Restore metadata is incomplete.");
    }

    let source = match validate_source_path(&PathBuf::from(&log.path_after)) {
        Ok(path) => path,
        Err(error) => return mark_restore_failed(log, error),
    };
    let target = match validate_target_path(&PathBuf::from(&log.path_before)) {
        Ok(path) => path,
        Err(error) => return mark_restore_failed(log, error),
    };

    if let Err(error) = ensure_not_protected(&source) {
        return mark_restore_failed(log, error);
    }
    if let Err(error) = ensure_not_protected(&target) {
        return mark_restore_failed(log, error);
    }
    if let Err(error) = move_file_no_overwrite(&source, &target) {
        return mark_restore_failed(log, error);
    }

    let mut restored = log.clone();
    restored.can_undo = false;
    restored.can_restore = false;
    restored.restored_at = Some(current_timestamp_ms().to_string());
    restored.restore_status = "restored".to_string();
    restored.restore_error = None;
    restored
}

fn mark_restore_failed(log: &OperationLogDto, error: impl Into<String>) -> OperationLogDto {
    let mut failed = log.clone();
    failed.restore_status = "failed".to_string();
    failed.restore_error = Some(error.into());
    failed
}

fn mark_restore_canceled(log: &OperationLogDto) -> OperationLogDto {
    let mut canceled = log.clone();
    canceled.restore_status = "canceled".to_string();
    canceled.restore_error = None;
    canceled
}

fn mark_restore_unavailable(log: &OperationLogDto, reason: impl Into<String>) -> OperationLogDto {
    let mut unavailable = log.clone();
    unavailable.can_undo = false;
    unavailable.can_restore = false;
    unavailable.restore_status = "unavailable".to_string();
    unavailable.restore_error = Some(reason.into());
    unavailable
}

fn restore_progress_batch_id(logs: &[OperationLogDto]) -> String {
    logs.first()
        .map(|log| log.batch_id.clone())
        .unwrap_or_else(|| format!("restore-{}", current_timestamp_ms()))
}

fn is_operation_cancelled(cancel_flag: &Arc<AtomicBool>) -> bool {
    cancel_flag.load(Ordering::Relaxed)
}

struct OperationProgressBuffer {
    kind: &'static str,
    batch_id: String,
    total: u64,
    last_emit_at: Instant,
    processed_since_emit: u64,
}

impl OperationProgressBuffer {
    fn new(kind: &'static str, batch_id: String, total: u64) -> Self {
        Self {
            kind,
            batch_id,
            total,
            last_emit_at: Instant::now(),
            processed_since_emit: 0,
        }
    }

    fn record(
        &mut self,
        emitter: &impl OperationProgressEmitter,
        processed: u64,
        current_path: String,
    ) {
        self.processed_since_emit += 1;
        let now = Instant::now();
        if processed == self.total
            || self.processed_since_emit >= OPERATION_PROGRESS_BATCH_SIZE
            || now.duration_since(self.last_emit_at) >= OPERATION_PROGRESS_EMIT_INTERVAL
        {
            emitter.emit_progress(OperationProgressPayload {
                kind: self.kind.to_string(),
                batch_id: self.batch_id.clone(),
                processed,
                total: self.total,
                current_path,
            });
            self.last_emit_at = now;
            self.processed_since_emit = 0;
        }
    }
}

fn validate_source_path(path: &Path) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(FileOpError::RelativePath.to_string());
    }
    if !path.exists() {
        return Err(FileOpError::SourceMissing.to_string());
    }

    let source = path
        .canonicalize()
        .map_err(|error| FileOpError::Io(error).to_string())?;
    if !source.is_file() {
        return Err(FileOpError::SourceNotFile.to_string());
    }

    Ok(source)
}

fn validate_target_path(path: &Path) -> Result<PathBuf, String> {
    validate_target_path_with_parent_policy(path, false)
}

fn validate_target_path_with_parent_policy(
    path: &Path,
    allow_create_parent: bool,
) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err(FileOpError::RelativePath.to_string());
    }
    if path
        .components()
        .any(|component| component == Component::ParentDir)
    {
        return Err(FileOpError::UnsafePathTraversal.to_string());
    }
    if path.exists() {
        return Err(FileOpError::TargetExists.to_string());
    }

    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or(FileOpError::UnsafeFileName)
        .map_err(|error| error.to_string())?;
    validate_safe_file_name(name)?;

    let parent = path
        .parent()
        .ok_or(FileOpError::TargetParentMissing)
        .map_err(|error| error.to_string())?;
    if !parent.exists() {
        if !allow_create_parent {
            return Err(FileOpError::TargetParentMissing.to_string());
        }
        ensure_not_protected(parent)?;
        fs::create_dir_all(parent).map_err(|error| FileOpError::Io(error).to_string())?;
    }
    let parent = parent
        .canonicalize()
        .map_err(|_| FileOpError::TargetParentMissing.to_string())?;

    Ok(parent.join(name))
}

fn move_file_with_parent_policy(
    source_path: String,
    target_path: String,
    allow_create_parent: bool,
) -> Result<FileOperationResult, String> {
    let source = validate_source_path(&PathBuf::from(source_path))?;
    let target =
        validate_target_path_with_parent_policy(&PathBuf::from(target_path), allow_create_parent)?;

    ensure_not_protected(&source)?;
    ensure_not_protected(&target)?;
    move_file_no_overwrite(&source, &target)?;

    Ok(FileOperationResult {
        operation: "move".to_string(),
        source_path: normalize_path(&source),
        target_path: normalize_path(&target),
    })
}

fn validate_safe_file_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.ends_with('.')
        || trimmed.ends_with(' ')
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(|ch| ch.is_control())
    {
        return Err(FileOpError::UnsafeFileName.to_string());
    }

    if cfg!(windows) {
        let stem = trimmed
            .split('.')
            .next()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let reserved = [
            "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7",
            "com8", "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
        ];
        if reserved.contains(&stem.as_str())
            || trimmed
                .chars()
                .any(|ch| matches!(ch, '<' | '>' | ':' | '"' | '|' | '?' | '*'))
        {
            return Err(FileOpError::UnsafeFileName.to_string());
        }
    }

    Ok(())
}

fn move_file_no_overwrite(source: &Path, target: &Path) -> Result<(), String> {
    if target.exists() {
        return Err(FileOpError::TargetExists.to_string());
    }

    match fs::hard_link(source, target) {
        Ok(()) => {
            if let Err(error) = fs::remove_file(source) {
                let _ = fs::remove_file(target);
                return Err(FileOpError::Io(error).to_string());
            }
            Ok(())
        }
        Err(link_error) if should_copy_fallback(&link_error) => copy_then_delete(source, target),
        Err(error) => Err(FileOpError::Io(error).to_string()),
    }
}

fn copy_then_delete(source: &Path, target: &Path) -> Result<(), String> {
    let mut reader = fs::File::open(source).map_err(|error| FileOpError::Io(error).to_string())?;
    let mut writer = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|error| {
            if target.exists() {
                FileOpError::TargetExists.to_string()
            } else {
                FileOpError::Io(error).to_string()
            }
        })?;

    if let Err(error) = io::copy(&mut reader, &mut writer) {
        let _ = fs::remove_file(target);
        return Err(FileOpError::Io(error).to_string());
    }
    if let Err(error) = writer.sync_all() {
        let _ = fs::remove_file(target);
        return Err(FileOpError::Io(error).to_string());
    }

    if let Err(error) = fs::remove_file(source) {
        let _ = fs::remove_file(target);
        return Err(FileOpError::Io(error).to_string());
    }

    Ok(())
}

fn should_copy_fallback(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::PermissionDenied | io::ErrorKind::Unsupported | io::ErrorKind::Other
    ) || matches!(
        error.raw_os_error(),
        Some(1) | Some(17) | Some(18) | Some(50) | Some(95)
    )
}

fn ensure_not_protected(path: &Path) -> Result<(), String> {
    let normalized = normalize_for_compare(path);
    for root in protected_roots() {
        let protected = normalize_for_compare(&root);
        if normalized == protected || normalized.starts_with(&format!("{protected}/")) {
            return Err(FileOpError::ProtectedPath(normalize_path(&root)).to_string());
        }
    }
    Ok(())
}

fn protected_roots() -> Vec<PathBuf> {
    let mut roots = Vec::new();

    if cfg!(windows) {
        let drive = env::var("SystemDrive").unwrap_or_else(|_| "C:".to_string());
        for dir in [
            "Windows",
            "Program Files",
            "Program Files (x86)",
            "ProgramData",
            "System Volume Information",
            "$Recycle.Bin",
            "$WINDOWS.~BT",
            "$WinREAgent",
            "Recovery",
        ] {
            roots.push(PathBuf::from(format!("{drive}\\{dir}")));
        }
    } else if cfg!(target_os = "macos") {
        roots.extend([
            PathBuf::from("/System"),
            PathBuf::from("/Library"),
            PathBuf::from("/bin"),
            PathBuf::from("/sbin"),
            PathBuf::from("/usr"),
            PathBuf::from("/etc"),
            PathBuf::from("/private"),
        ]);
    } else {
        roots.extend([
            PathBuf::from("/bin"),
            PathBuf::from("/boot"),
            PathBuf::from("/dev"),
            PathBuf::from("/etc"),
            PathBuf::from("/lib"),
            PathBuf::from("/lib64"),
            PathBuf::from("/proc"),
            PathBuf::from("/root"),
            PathBuf::from("/run"),
            PathBuf::from("/sbin"),
            PathBuf::from("/sys"),
            PathBuf::from("/usr"),
            PathBuf::from("/var"),
        ]);
    }

    roots
}

fn build_reveal_command(path: &Path) -> Result<RevealCommand, String> {
    if path.as_os_str().is_empty() {
        return Err("Path cannot be empty.".to_string());
    }

    #[cfg(windows)]
    {
        return Ok(RevealCommand {
            program: "explorer",
            args: vec![format!(
                "/select,{}",
                path.to_string_lossy().replace('/', "\\")
            )],
        });
    }

    #[cfg(target_os = "macos")]
    {
        return Ok(RevealCommand {
            program: "open",
            args: vec!["-R".to_string(), path.to_string_lossy().into_owned()],
        });
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let directory = if path.is_dir() {
            path
        } else {
            path.parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .unwrap_or(path)
        };
        return Ok(RevealCommand {
            program: "xdg-open",
            args: vec![directory.to_string_lossy().into_owned()],
        });
    }

    #[allow(unreachable_code)]
    Err("Reveal in folder is not supported on this platform.".to_string())
}

fn normalize_for_compare(path: &Path) -> String {
    let value = normalize_path(path).trim_end_matches('/').to_string();
    if cfg!(windows) {
        value.to_ascii_lowercase()
    } else {
        value
    }
}

fn normalize_path(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn current_timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::{Database, InsertFileRequest};
    use std::{
        fs,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn execute_moves_core_moves_files_and_returns_success_log() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");

        let source = source_dir.join("sample.txt");
        let target = target_dir.join("sample.txt");
        fs::write(&source, "hello").expect("write source");

        let result = execute_moves_core(ExecuteMovesRequest {
            operations: vec![OperationPreviewRequest {
                id: "op-1".to_string(),
                file_id: "file-1".to_string(),
                operation_type: "move".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                old_name: "sample.txt".to_string(),
                new_name: "sample.txt".to_string(),
                is_executable: Some(true),
            }],
        });

        assert!(!source.exists());
        assert!(target.exists());
        assert_eq!(result.logs.len(), 1);
        assert_eq!(result.logs[0].status, "success");
        assert_eq!(result.logs[0].operation_type, "move");
        assert_eq!(result.updated_files.len(), 0);
    }

    #[test]
    fn execute_moves_core_creates_safe_missing_target_parent() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("ZenCanvas").join("20_Areas").join("Projects");
        fs::create_dir_all(&source_dir).expect("source dir");

        let source = source_dir.join("sample.txt");
        let target = target_dir.join("sample.txt");
        fs::write(&source, "hello").expect("write source");

        let result = execute_moves_core(ExecuteMovesRequest {
            operations: vec![OperationPreviewRequest {
                id: "op-create-parent".to_string(),
                file_id: "file-create-parent".to_string(),
                operation_type: "move".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                old_name: "sample.txt".to_string(),
                new_name: "sample.txt".to_string(),
                is_executable: Some(true),
            }],
        });

        assert!(!source.exists());
        assert!(target.exists());
        assert_eq!(fs::read_to_string(&target).expect("read target"), "hello");
        assert_eq!(result.logs[0].status, "success");
        assert_eq!(
            result.logs[0].source_path,
            source.to_string_lossy().into_owned()
        );
        assert!(result.logs[0]
            .target_path
            .replace('\\', "/")
            .ends_with("ZenCanvas/20_Areas/Projects/sample.txt"));
    }

    #[test]
    fn execute_moves_core_refuses_to_overwrite_existing_target() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");

        let source = source_dir.join("sample.txt");
        let target = target_dir.join("sample.txt");
        fs::write(&source, "hello").expect("write source");
        fs::write(&target, "existing").expect("write existing target");

        let result = execute_moves_core(ExecuteMovesRequest {
            operations: vec![OperationPreviewRequest {
                id: "op-no-overwrite".to_string(),
                file_id: "file-no-overwrite".to_string(),
                operation_type: "move".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                old_name: "sample.txt".to_string(),
                new_name: "sample.txt".to_string(),
                is_executable: Some(true),
            }],
        });

        assert!(source.exists());
        assert_eq!(
            fs::read_to_string(&target).expect("read target"),
            "existing"
        );
        assert_eq!(result.logs[0].status, "failed");
        assert!(result.logs[0]
            .error_message
            .as_deref()
            .unwrap_or_default()
            .contains("Target file already exists"));
    }

    #[test]
    fn execute_moves_core_marks_remaining_operations_skipped_when_cancelled() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");
        let operations = (0..11)
            .map(|index| {
                let source = source_dir.join(format!("sample-{index}.txt"));
                let target = target_dir.join(format!("sample-{index}.txt"));
                fs::write(&source, "hello").expect("write source");
                preview_operation(index, &source, &target)
            })
            .collect::<Vec<_>>();
        let cancelled_source = PathBuf::from(&operations[10].source_path);
        let cancelled_target = PathBuf::from(&operations[10].target_path);
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let progress =
            RecordingOperationProgressEmitter::cancel_after(10, Arc::clone(&cancel_flag));

        let result = execute_moves_core_with_progress(
            ExecuteMovesRequest { operations },
            Arc::clone(&cancel_flag),
            &progress,
        );

        assert_eq!(
            result
                .logs
                .iter()
                .filter(|log| log.status == "success")
                .count(),
            10
        );
        assert_eq!(
            result
                .logs
                .iter()
                .filter(|log| log.status == "skipped")
                .count(),
            1
        );
        assert!(cancelled_source.exists());
        assert!(!cancelled_target.exists());
        assert!(result.logs[10].error_message.is_none());
        assert_eq!(
            progress.events().last().map(|event| event.processed),
            Some(11)
        );
        assert_eq!(progress.events().last().map(|event| event.total), Some(11));
    }

    #[test]
    fn restore_moves_core_restores_successful_move_log() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");

        let source = source_dir.join("sample.txt");
        let target = target_dir.join("sample.txt");
        fs::write(&source, "hello").expect("write source");

        let executed = execute_moves_core(ExecuteMovesRequest {
            operations: vec![OperationPreviewRequest {
                id: "op-1".to_string(),
                file_id: "file-1".to_string(),
                operation_type: "move".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                old_name: "sample.txt".to_string(),
                new_name: "sample.txt".to_string(),
                is_executable: Some(true),
            }],
        });

        let restored = restore_moves_core(RestoreMovesRequest {
            logs: executed.logs.clone(),
        });

        assert!(source.exists());
        assert!(!target.exists());
        assert_eq!(restored.restored, 1);
        assert_eq!(restored.failed, 0);
        assert_eq!(restored.logs.len(), 1);
        assert_eq!(restored.logs[0].restore_status, "restored");
        assert!(!restored.logs[0].can_restore);
        assert!(restored.logs[0].restored_at.is_some());
    }

    #[test]
    fn restore_moves_core_marks_remaining_logs_canceled_when_cancelled() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");
        let operations = (0..11)
            .map(|index| {
                let source = source_dir.join(format!("restore-{index}.txt"));
                let target = target_dir.join(format!("restore-{index}.txt"));
                fs::write(&source, "hello").expect("write source");
                preview_operation(index, &source, &target)
            })
            .collect::<Vec<_>>();
        let executed = execute_moves_core(ExecuteMovesRequest { operations });
        let canceled_log = executed.logs[10].clone();
        let cancel_flag = Arc::new(AtomicBool::new(false));
        let progress =
            RecordingOperationProgressEmitter::cancel_after(10, Arc::clone(&cancel_flag));

        let restored = restore_moves_core_with_progress(
            RestoreMovesRequest {
                logs: executed.logs.clone(),
            },
            Arc::clone(&cancel_flag),
            &progress,
        );

        assert_eq!(restored.restored, 10);
        assert_eq!(restored.failed, 0);
        assert_eq!(restored.logs[10].restore_status, "canceled");
        assert!(restored.logs[10].restore_error.is_none());
        assert!(!PathBuf::from(canceled_log.path_before).exists());
        assert!(PathBuf::from(canceled_log.path_after).exists());
        assert_eq!(
            progress.events().last().map(|event| event.processed),
            Some(11)
        );
        assert_eq!(progress.events().last().map(|event| event.total), Some(11));
    }

    #[test]
    fn restore_moves_refuses_to_overwrite_original_path() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");

        let source = source_dir.join("sample.txt");
        let target = target_dir.join("sample.txt");
        fs::write(&source, "hello").expect("write source");

        let executed = execute_moves_core(ExecuteMovesRequest {
            operations: vec![OperationPreviewRequest {
                id: "op-1".to_string(),
                file_id: "file-1".to_string(),
                operation_type: "move".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: target.to_string_lossy().into_owned(),
                old_name: "sample.txt".to_string(),
                new_name: "sample.txt".to_string(),
                is_executable: Some(true),
            }],
        });

        fs::write(&source, "new file").expect("write conflicting source");
        let restored = restore_moves_core(RestoreMovesRequest {
            logs: executed.logs.clone(),
        });

        assert_eq!(
            fs::read_to_string(&source).expect("read conflict"),
            "new file"
        );
        assert!(target.exists());
        assert_eq!(restored.restored, 0);
        assert_eq!(restored.failed, 1);
        assert_eq!(restored.logs[0].restore_status, "failed");
        assert!(restored.logs[0]
            .restore_error
            .as_deref()
            .unwrap_or_default()
            .contains("Target file already exists"));
    }

    #[test]
    fn restore_moves_restores_successful_rename_log() {
        let root = test_dir();
        fs::create_dir_all(&root).expect("root dir");

        let source = root.join("old-name.txt");
        let renamed = root.join("new-name.txt");
        fs::write(&source, "hello").expect("write source");

        let executed = execute_moves_core(ExecuteMovesRequest {
            operations: vec![OperationPreviewRequest {
                id: "op-1".to_string(),
                file_id: "file-1".to_string(),
                operation_type: "rename".to_string(),
                source_path: source.to_string_lossy().into_owned(),
                target_path: renamed.to_string_lossy().into_owned(),
                old_name: "old-name.txt".to_string(),
                new_name: "new-name.txt".to_string(),
                is_executable: Some(true),
            }],
        });

        assert!(!source.exists());
        assert!(renamed.exists());

        let restored = restore_moves_core(RestoreMovesRequest {
            logs: executed.logs.clone(),
        });

        assert!(source.exists());
        assert!(!renamed.exists());
        assert_eq!(restored.restored, 1);
        assert_eq!(restored.logs[0].restore_status, "restored");
    }

    #[test]
    fn execute_moves_updates_file_record_after_rename() {
        let db = Database::open(test_db_path()).expect("open database");
        let root = test_dir();
        let source = root.join("old-name.txt");
        let renamed = root.join("new-name.txt");
        fs::write(&source, "hello").expect("write source");
        insert_indexed_file(&db, &source, "old-name.txt", "txt");

        let result = execute_moves_with_persistence(
            &db,
            ExecuteMovesRequest {
                operations: vec![OperationPreviewRequest {
                    id: "op-rename".to_string(),
                    file_id: source.to_string_lossy().into_owned(),
                    operation_type: "rename".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    target_path: renamed.to_string_lossy().into_owned(),
                    old_name: "old-name.txt".to_string(),
                    new_name: "new-name.txt".to_string(),
                    is_executable: Some(true),
                }],
            },
        )
        .expect("execute moves with persistence");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(result.logs[0].status, "success");
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].name, "new-name.txt");
        assert_eq!(page.files[0].path, normalize_path(&renamed));
        assert_eq!(page.files[0].id, normalize_path(&renamed));
        assert_eq!(page.files[0].extension, "txt");
        assert_eq!(page.files[0].suggested_action, "Keep");
        assert!(!page.files[0].requires_confirmation);
    }

    #[test]
    fn execute_moves_updates_fts_after_rename() {
        let db = Database::open(test_db_path()).expect("open database");
        let root = test_dir();
        let source = root.join("old-name.txt");
        let renamed = root.join("new-report.txt");
        fs::write(&source, "hello").expect("write source");
        insert_indexed_file(&db, &source, "old-name.txt", "txt");

        execute_moves_with_persistence(
            &db,
            ExecuteMovesRequest {
                operations: vec![OperationPreviewRequest {
                    id: "op-rename".to_string(),
                    file_id: source.to_string_lossy().into_owned(),
                    operation_type: "rename".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    target_path: renamed.to_string_lossy().into_owned(),
                    old_name: "old-name.txt".to_string(),
                    new_name: "new-report.txt".to_string(),
                    is_executable: Some(true),
                }],
            },
        )
        .expect("execute moves with persistence");

        let new_results = db.search_files("new-report", Some(10)).expect("search new");
        let old_results = db.search_files("old-name", Some(10)).expect("search old");

        assert_eq!(new_results.len(), 1);
        assert_eq!(new_results[0].name, "new-report.txt");
        assert_eq!(new_results[0].path, normalize_path(&renamed));
        assert!(old_results
            .iter()
            .all(|result| result.path != normalize_path(&source)));
    }

    #[test]
    fn execute_moves_updates_file_record_after_move() {
        let db = Database::open(test_db_path()).expect("open database");
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");
        let source = source_dir.join("a.txt");
        let target = target_dir.join("a.txt");
        fs::write(&source, "hello").expect("write source");
        insert_indexed_file(&db, &source, "a.txt", "txt");

        execute_moves_with_persistence(
            &db,
            ExecuteMovesRequest {
                operations: vec![OperationPreviewRequest {
                    id: "op-move".to_string(),
                    file_id: source.to_string_lossy().into_owned(),
                    operation_type: "move".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    target_path: target.to_string_lossy().into_owned(),
                    old_name: "a.txt".to_string(),
                    new_name: "a.txt".to_string(),
                    is_executable: Some(true),
                }],
            },
        )
        .expect("execute moves with persistence");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].path, normalize_path(&target));
        assert_eq!(page.files[0].id, normalize_path(&target));
    }

    #[test]
    fn execute_moves_does_not_fail_when_file_record_missing() {
        let db = Database::open(test_db_path()).expect("open database");
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");
        let source = source_dir.join("missing-record.txt");
        let target = target_dir.join("missing-record.txt");
        fs::write(&source, "hello").expect("write source");

        let result = execute_moves_with_persistence(
            &db,
            ExecuteMovesRequest {
                operations: vec![OperationPreviewRequest {
                    id: "op-missing-record".to_string(),
                    file_id: source.to_string_lossy().into_owned(),
                    operation_type: "move".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    target_path: target.to_string_lossy().into_owned(),
                    old_name: "missing-record.txt".to_string(),
                    new_name: "missing-record.txt".to_string(),
                    is_executable: Some(true),
                }],
            },
        )
        .expect("execute moves with persistence");
        let logs = db.get_operation_logs(Some(10)).expect("operation logs");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(result.logs[0].status, "success");
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].id, result.logs[0].id);
        assert_eq!(page.total, 0);
        assert!(target.exists());
    }

    #[test]
    fn restore_moves_updates_file_record_after_move_restore() {
        let db = Database::open(test_db_path()).expect("open database");
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");
        let source = source_dir.join("a.txt");
        let target = target_dir.join("a.txt");
        fs::write(&source, "hello").expect("write source");
        insert_indexed_file(&db, &source, "a.txt", "txt");

        let executed = execute_moves_with_persistence(
            &db,
            ExecuteMovesRequest {
                operations: vec![OperationPreviewRequest {
                    id: "op-move".to_string(),
                    file_id: source.to_string_lossy().into_owned(),
                    operation_type: "move".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    target_path: target.to_string_lossy().into_owned(),
                    old_name: "a.txt".to_string(),
                    new_name: "a.txt".to_string(),
                    is_executable: Some(true),
                }],
            },
        )
        .expect("execute moves with persistence");

        restore_moves_with_persistence(
            &db,
            RestoreMovesRequest {
                logs: executed.logs.clone(),
            },
        )
        .expect("restore moves with persistence");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].path, normalize_path(&source));
        assert_eq!(page.files[0].id, normalize_path(&source));
        assert_eq!(page.files[0].name, "a.txt");
        assert_eq!(page.files[0].extension, "txt");
        assert_eq!(page.files[0].suggested_action, "Keep");
        assert!(!page.files[0].requires_confirmation);
    }

    #[test]
    fn restore_moves_updates_file_record_after_rename_restore() {
        let db = Database::open(test_db_path()).expect("open database");
        let root = test_dir();
        let source = root.join("old-name.txt");
        let renamed = root.join("new-name.txt");
        fs::write(&source, "hello").expect("write source");
        insert_indexed_file(&db, &source, "old-name.txt", "txt");

        let executed = execute_moves_with_persistence(
            &db,
            ExecuteMovesRequest {
                operations: vec![OperationPreviewRequest {
                    id: "op-rename".to_string(),
                    file_id: source.to_string_lossy().into_owned(),
                    operation_type: "rename".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    target_path: renamed.to_string_lossy().into_owned(),
                    old_name: "old-name.txt".to_string(),
                    new_name: "new-name.txt".to_string(),
                    is_executable: Some(true),
                }],
            },
        )
        .expect("execute moves with persistence");

        let after_execute = db.get_paged_files(Some(10), Some(0), None).expect("page");
        assert_eq!(after_execute.files[0].name, "new-name.txt");

        restore_moves_with_persistence(
            &db,
            RestoreMovesRequest {
                logs: executed.logs.clone(),
            },
        )
        .expect("restore moves with persistence");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].name, "old-name.txt");
        assert_eq!(page.files[0].path, normalize_path(&source));
        assert_eq!(page.files[0].id, normalize_path(&source));
        assert_eq!(page.files[0].extension, "txt");
    }

    #[test]
    fn restore_moves_updates_fts_after_restore() {
        let db = Database::open(test_db_path()).expect("open database");
        let root = test_dir();
        let source = root.join("old-report.txt");
        let renamed = root.join("new-report.txt");
        fs::write(&source, "hello").expect("write source");
        insert_indexed_file(&db, &source, "old-report.txt", "txt");

        let executed = execute_moves_with_persistence(
            &db,
            ExecuteMovesRequest {
                operations: vec![OperationPreviewRequest {
                    id: "op-rename".to_string(),
                    file_id: source.to_string_lossy().into_owned(),
                    operation_type: "rename".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    target_path: renamed.to_string_lossy().into_owned(),
                    old_name: "old-report.txt".to_string(),
                    new_name: "new-report.txt".to_string(),
                    is_executable: Some(true),
                }],
            },
        )
        .expect("execute moves with persistence");
        assert_eq!(
            db.search_files("new-report", Some(10))
                .expect("search after execute")
                .len(),
            1
        );

        restore_moves_with_persistence(
            &db,
            RestoreMovesRequest {
                logs: executed.logs.clone(),
            },
        )
        .expect("restore moves with persistence");
        let old_results = db
            .search_files("old-report", Some(10))
            .expect("search old after restore");
        let new_results = db
            .search_files("new-report", Some(10))
            .expect("search new after restore");

        assert_eq!(old_results.len(), 1);
        assert_eq!(old_results[0].path, normalize_path(&source));
        assert_eq!(old_results[0].name, "old-report.txt");
        assert!(new_results
            .iter()
            .all(|result| result.path != normalize_path(&renamed)));
    }

    #[test]
    fn restore_moves_does_not_fail_when_file_record_missing() {
        let db = Database::open(test_db_path()).expect("open database");
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");
        let source = source_dir.join("missing-record.txt");
        let target = target_dir.join("missing-record.txt");
        fs::write(&source, "hello").expect("write source");

        let executed = execute_moves_with_persistence(
            &db,
            ExecuteMovesRequest {
                operations: vec![OperationPreviewRequest {
                    id: "op-missing-record".to_string(),
                    file_id: source.to_string_lossy().into_owned(),
                    operation_type: "move".to_string(),
                    source_path: source.to_string_lossy().into_owned(),
                    target_path: target.to_string_lossy().into_owned(),
                    old_name: "missing-record.txt".to_string(),
                    new_name: "missing-record.txt".to_string(),
                    is_executable: Some(true),
                }],
            },
        )
        .expect("execute moves with persistence");

        let restored = restore_moves_with_persistence(
            &db,
            RestoreMovesRequest {
                logs: executed.logs.clone(),
            },
        )
        .expect("restore moves with persistence");
        let logs = db.get_operation_logs(Some(10)).expect("operation logs");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(restored.restored, 1);
        assert_eq!(restored.logs[0].restore_status, "restored");
        assert_eq!(logs[0].restore_status, "restored");
        assert_eq!(page.total, 0);
        assert!(source.exists());
    }

    #[cfg(windows)]
    #[test]
    fn build_reveal_command_selects_file_with_windows_explorer() {
        let command = build_reveal_command(Path::new("C:/Users/example/Documents/sample.txt"))
            .expect("reveal command");

        assert_eq!(command.program, "explorer");
        assert_eq!(
            command.args,
            vec!["/select,C:\\Users\\example\\Documents\\sample.txt"]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn build_reveal_command_selects_file_with_macos_open() {
        let command = build_reveal_command(Path::new("/Users/example/Documents/sample.txt"))
            .expect("reveal command");

        assert_eq!(command.program, "open");
        assert_eq!(
            command.args,
            vec!["-R", "/Users/example/Documents/sample.txt"]
        );
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    #[test]
    fn build_reveal_command_opens_parent_directory_on_linux() {
        let command = build_reveal_command(Path::new("/home/example/Documents/sample.txt"))
            .expect("reveal command");

        assert_eq!(command.program, "xdg-open");
        assert_eq!(command.args, vec!["/home/example/Documents"]);
    }

    fn test_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("zen-canvas-file-op-test-{nonce}"));
        fs::create_dir_all(&dir).expect("test dir");
        dir
    }

    fn test_db_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("zen-canvas-file-op-db-test-{nonce}.sqlite3"))
    }

    fn insert_indexed_file(db: &Database, path: &Path, name: &str, extension: &str) {
        let path = path.to_string_lossy().into_owned();
        db.insert_file(InsertFileRequest {
            id: path.clone(),
            path,
            name: name.to_string(),
            extension: extension.to_string(),
            size: 5,
            mtime: 1_900_000_000,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert indexed file");
    }

    fn preview_operation(index: usize, source: &Path, target: &Path) -> OperationPreviewRequest {
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("sample.txt")
            .to_string();
        OperationPreviewRequest {
            id: format!("op-{index}"),
            file_id: source.to_string_lossy().into_owned(),
            operation_type: "move".to_string(),
            source_path: source.to_string_lossy().into_owned(),
            target_path: target.to_string_lossy().into_owned(),
            old_name: name.clone(),
            new_name: name,
            is_executable: Some(true),
        }
    }

    struct RecordingOperationProgressEmitter {
        events: std::cell::RefCell<Vec<OperationProgressPayload>>,
        cancel_after: u64,
        cancel_flag: Arc<AtomicBool>,
    }

    impl RecordingOperationProgressEmitter {
        fn cancel_after(cancel_after: u64, cancel_flag: Arc<AtomicBool>) -> Self {
            Self {
                events: std::cell::RefCell::new(Vec::new()),
                cancel_after,
                cancel_flag,
            }
        }

        fn events(&self) -> Vec<OperationProgressPayload> {
            self.events.borrow().clone()
        }
    }

    impl OperationProgressEmitter for RecordingOperationProgressEmitter {
        fn emit_progress(&self, payload: OperationProgressPayload) {
            if payload.processed >= self.cancel_after {
                self.cancel_flag.store(true, Ordering::Relaxed);
            }
            self.events.borrow_mut().push(payload);
        }
    }
}
