use serde::{Deserialize, Serialize};
use std::{
    env,
    fs::{self, OpenOptions},
    io,
    path::{Path, PathBuf},
    process::Command as ProcessCommand,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::command;
use thiserror::Error;

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
pub fn execute_moves(request: ExecuteMovesRequest) -> Result<ExecuteMovesResult, String> {
    let batch_id = format!("batch-{}", current_timestamp_ms());
    let created_at = current_timestamp_ms().to_string();
    let logs = request
        .operations
        .iter()
        .enumerate()
        .map(|(index, operation)| {
            execute_preview_operation(&batch_id, &created_at, index, operation)
        })
        .collect::<Vec<_>>();

    Ok(ExecuteMovesResult {
        logs,
        updated_files: Vec::new(),
        batch_id,
    })
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
            "move" | "move_rename" => {
                move_file(operation.source_path.clone(), operation.target_path.clone())
            }
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
pub fn restore_moves(request: RestoreMovesRequest) -> Result<RestoreMovesResult, String> {
    let mut restored = 0_usize;
    let mut failed = 0_usize;
    let logs = request
        .logs
        .iter()
        .map(|log| {
            let result = restore_operation_log(log);
            if result.restore_status == "restored" {
                restored += 1;
            } else if result.restore_status == "failed" {
                failed += 1;
            }
            result
        })
        .collect::<Vec<_>>();

    Ok(RestoreMovesResult {
        logs,
        restored,
        failed,
    })
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

fn mark_restore_unavailable(log: &OperationLogDto, reason: impl Into<String>) -> OperationLogDto {
    let mut unavailable = log.clone();
    unavailable.can_undo = false;
    unavailable.can_restore = false;
    unavailable.restore_status = "unavailable".to_string();
    unavailable.restore_error = Some(reason.into());
    unavailable
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
    if !path.is_absolute() {
        return Err(FileOpError::RelativePath.to_string());
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
    let parent = parent
        .canonicalize()
        .map_err(|_| FileOpError::TargetParentMissing.to_string())?;

    Ok(parent.join(name))
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
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn execute_moves_moves_files_and_returns_success_log() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");

        let source = source_dir.join("sample.txt");
        let target = target_dir.join("sample.txt");
        fs::write(&source, "hello").expect("write source");

        let result = execute_moves(ExecuteMovesRequest {
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
        })
        .expect("execute moves");

        assert!(!source.exists());
        assert!(target.exists());
        assert_eq!(result.logs.len(), 1);
        assert_eq!(result.logs[0].status, "success");
        assert_eq!(result.logs[0].operation_type, "move");
        assert_eq!(result.updated_files.len(), 0);
    }

    #[test]
    fn restore_moves_restores_successful_move_log() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");

        let source = source_dir.join("sample.txt");
        let target = target_dir.join("sample.txt");
        fs::write(&source, "hello").expect("write source");

        let executed = execute_moves(ExecuteMovesRequest {
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
        })
        .expect("execute moves");

        let restored = restore_moves(RestoreMovesRequest {
            logs: executed.logs.clone(),
        })
        .expect("restore moves");

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
    fn restore_moves_refuses_to_overwrite_original_path() {
        let root = test_dir();
        let source_dir = root.join("source");
        let target_dir = root.join("target");
        fs::create_dir_all(&source_dir).expect("source dir");
        fs::create_dir_all(&target_dir).expect("target dir");

        let source = source_dir.join("sample.txt");
        let target = target_dir.join("sample.txt");
        fs::write(&source, "hello").expect("write source");

        let executed = execute_moves(ExecuteMovesRequest {
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
        })
        .expect("execute moves");

        fs::write(&source, "new file").expect("write conflicting source");
        let restored = restore_moves(RestoreMovesRequest {
            logs: executed.logs.clone(),
        })
        .expect("restore moves");

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

        let executed = execute_moves(ExecuteMovesRequest {
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
        })
        .expect("execute rename");

        assert!(!source.exists());
        assert!(renamed.exists());

        let restored = restore_moves(RestoreMovesRequest {
            logs: executed.logs.clone(),
        })
        .expect("restore rename");

        assert!(source.exists());
        assert!(!renamed.exists());
        assert_eq!(restored.restored, 1);
        assert_eq!(restored.logs[0].restore_status, "restored");
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
        let command =
            build_reveal_command(Path::new("/Users/example/Documents/sample.txt"))
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
        let command =
            build_reveal_command(Path::new("/home/example/Documents/sample.txt"))
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
}
