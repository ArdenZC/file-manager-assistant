use super::*;
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Runtime};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

pub(crate) mod files;
pub(crate) mod operations;
pub(crate) mod rules_repo;

use rules_repo::current_timestamp_iso;

pub(crate) fn trim_trailing_path_separators(path: &str) -> &str {
    let mut end = path.len();
    while end > 1 {
        let current = &path[..end];
        if !(current.ends_with('\\') || current.ends_with('/')) {
            break;
        }
        if end == 3 && current.as_bytes().get(1) == Some(&b':') {
            break;
        }
        end -= 1;
    }
    &path[..end]
}

fn escape_like_pattern(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for ch in value.chars() {
        if matches!(ch, '~' | '%' | '_') {
            escaped.push('~');
        }
        escaped.push(ch);
    }
    escaped
}

pub(crate) fn build_fts_query(input: &str) -> Option<String> {
    let phrases = input
        .split_whitespace()
        .filter(|phrase| !phrase.is_empty())
        .take(12)
        .map(quote_fts_phrase)
        .collect::<Vec<_>>();

    if phrases.is_empty() {
        None
    } else {
        Some(phrases.join(" AND "))
    }
}

fn quote_fts_phrase(phrase: &str) -> String {
    format!("\"{}\"", phrase.replace('"', "\"\""))
}

pub(crate) fn bool_to_i64(value: bool) -> i64 {
    if value {
        1
    } else {
        0
    }
}

pub(crate) fn path_lookup_candidates(first: &str, second: &str) -> Vec<String> {
    path_lookup_candidates_for_values(&[first, second])
}

fn path_lookup_candidates_for_values(values: &[&str]) -> Vec<String> {
    let mut candidates = Vec::new();
    for value in values {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            continue;
        }
        push_unique(&mut candidates, trimmed.to_string());
        push_unique(&mut candidates, normalize_path_text(trimmed));
    }
    candidates
}

pub(crate) fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|item| item == &value) {
        values.push(value);
    }
}

fn normalize_path_for_db(path: &Path) -> String {
    normalize_path_text(&path.to_string_lossy())
}

pub(crate) fn normalize_path_text(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    if let Some(stripped) = normalized.strip_prefix("//?/UNC/") {
        return format!("//{stripped}");
    }
    if let Some(stripped) = normalized.strip_prefix("//?/") {
        return stripped.to_string();
    }
    normalized
}

fn resolved_file_name(target_path: &str, new_name: &str) -> String {
    let trimmed = new_name.trim();
    if !trimmed.is_empty() {
        return trimmed.to_string();
    }

    target_path
        .trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(target_path)
        .to_string()
}

fn extension_from_file_name(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_string()
}

fn find_file_row_id(conn: &Connection, candidates: &[String]) -> Result<Option<String>, DbError> {
    for candidate in candidates {
        let found = conn
            .query_row(
                "SELECT id FROM files WHERE id = ?1 OR path = ?1 LIMIT 1",
                params![candidate],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        if found.is_some() {
            return Ok(found);
        }
    }
    Ok(None)
}

fn system_time_to_unix_seconds(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
}

pub(crate) fn current_unix_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_secs()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}

pub fn upsert_files_by_paths_for_db(db: &Database, paths: &[String]) -> Result<usize, DbError> {
    let mut files = Vec::new();
    let mut seen = Vec::new();

    for raw_path in paths
        .iter()
        .map(|path| path.trim())
        .filter(|path| !path.is_empty())
    {
        let path = trim_trailing_path_separators(raw_path);
        if path.is_empty() {
            continue;
        }

        let path_buf = PathBuf::from(path);
        let metadata = match fs::metadata(&path_buf) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(DbError::Io(error)),
        };
        let normalized_path = normalize_path_for_db(&path_buf);
        if seen.iter().any(|value| value == &normalized_path) {
            continue;
        }
        push_unique(&mut seen, normalized_path.clone());

        files.push(insert_request_from_metadata(
            normalized_path,
            &path_buf,
            &metadata,
        ));
    }

    let upserted = files.len();
    if upserted > 0 {
        db.insert_files(&files)?;
    }
    Ok(upserted)
}

pub(crate) fn upsert_files_by_paths_with_optional_optimize(
    db: &Database,
    paths: &[String],
) -> Result<usize, DbError> {
    let upserted = upsert_files_by_paths_for_db(db, paths)?;
    let _ = optimize_search_index_after_bulk_upsert(db, upserted);
    Ok(upserted)
}

pub(crate) fn optimize_search_index_after_bulk_upsert(
    db: &Database,
    upserted: usize,
) -> Option<SearchIndexOptimizeReport> {
    if upserted >= OPTIMIZE_AFTER_UPSERT_THRESHOLD {
        Some(run_search_index_optimize("watcher_bulk_upsert", db))
    } else {
        None
    }
}

pub fn run_search_index_optimize(trigger: &str, db: &Database) -> SearchIndexOptimizeReport {
    let started = Instant::now();
    match db.optimize_search_index() {
        Ok(duration_ms) => SearchIndexOptimizeReport {
            trigger: trigger.to_string(),
            duration_ms,
            success: true,
            error: None,
        },
        Err(error) => {
            let message = error.to_string();
            eprintln!("SQLite/FTS optimize failed for {trigger}: {message}");
            SearchIndexOptimizeReport {
                trigger: trigger.to_string(),
                duration_ms: started.elapsed().as_millis(),
                success: false,
                error: Some(message),
            }
        }
    }
}

pub fn emit_search_index_optimized<R: Runtime>(
    app: &AppHandle<R>,
    report: &SearchIndexOptimizeReport,
) {
    if let Err(error) = app.emit(SEARCH_INDEX_OPTIMIZED_EVENT, report) {
        eprintln!(
            "Failed to emit {SEARCH_INDEX_OPTIMIZED_EVENT} event for {}: {error}",
            report.trigger
        );
    }
}

fn insert_request_from_metadata(
    normalized_path: String,
    path: &Path,
    metadata: &fs::Metadata,
) -> InsertFileRequest {
    let is_dir = metadata.is_dir();
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or_else(|| resolved_file_name(&normalized_path, ""));
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let size = if metadata.is_file() {
        i64::try_from(metadata.len()).unwrap_or(i64::MAX)
    } else {
        0
    };
    let mtime = metadata
        .modified()
        .ok()
        .and_then(system_time_to_unix_seconds)
        .unwrap_or_else(current_unix_seconds);
    let ctime = metadata
        .created()
        .ok()
        .and_then(system_time_to_unix_seconds)
        .unwrap_or(mtime);

    InsertFileRequest {
        id: normalized_path.clone(),
        path: normalized_path,
        name,
        extension,
        size,
        mtime,
        ctime,
        is_dir,
        state_code: 0,
    }
}

pub(crate) fn indexed_file_from_row(row: &Row<'_>) -> rusqlite::Result<IndexedFileRow> {
    Ok(IndexedFileRow {
        id: row.get(0)?,
        path: row.get(1)?,
        name: row.get(2)?,
        extension: row.get(3)?,
        size: row.get(4)?,
        mtime: row.get(5)?,
        ctime: row.get(6)?,
        is_dir: row.get::<_, i64>(7)? != 0,
        state_code: row.get(8)?,
        file_type: row.get(9)?,
        purpose: row.get(10)?,
        lifecycle: row.get(11)?,
        context: row.get(12)?,
        risk_level: row.get(13)?,
        suggested_action: row.get(14)?,
        suggested_target_path: row.get(15)?,
        suggested_name: row.get(16)?,
        confidence: row.get(17)?,
        classification_reason: row.get(18)?,
        classification_status: row.get(19)?,
        matched_rules: row.get(20)?,
        requires_confirmation: row.get::<_, i64>(21)? != 0,
        content_hash: row.get(22)?,
        is_duplicate: row.get::<_, i64>(23)? != 0,
        is_stale: row.get::<_, i64>(24)? != 0,
        last_seen_at: row.get(25)?,
        last_classified_at: row.get(26)?,
        classified_rule_version: row.get(27)?,
        last_classified_mtime: row.get(28)?,
        last_classified_size: row.get(29)?,
    })
}

fn file_record_from_indexed(row: IndexedFileRow, now: &str) -> FileRecordDto {
    let created_at = unix_seconds_to_iso(if row.ctime == 0 { row.mtime } else { row.ctime });
    let modified_at = unix_seconds_to_iso(row.mtime);
    let last_seen_at = unix_seconds_to_iso(if row.last_seen_at == 0 {
        row.mtime
    } else {
        row.last_seen_at
    });
    let file_type = normalized_file_type(&row);
    let matched_rules = serde_json::from_str::<Vec<String>>(&row.matched_rules).unwrap_or_default();

    FileRecordDto {
        id: row.id,
        name: row.name.clone(),
        path: row.path.clone(),
        directory: parent_directory(&row.path),
        extension: row.extension,
        size: row.size,
        file_type,
        purpose: row.purpose,
        lifecycle: row.lifecycle,
        context: row.context,
        risk_level: row.risk_level,
        hash: (!row.content_hash.is_empty()).then_some(row.content_hash.clone()),
        created_at,
        modified_at,
        scanned_at: now.to_string(),
        last_seen_at,
        is_hidden: row.name.starts_with('.'),
        is_deleted: false,
        is_duplicate: row.is_duplicate,
        suggested_action: row.suggested_action,
        suggested_target_path: row.suggested_target_path,
        suggested_name: if row.suggested_name.is_empty() {
            row.name
        } else {
            row.suggested_name
        },
        confidence: row.confidence,
        classification_reason: row.classification_reason,
        classification_status: row.classification_status,
        matched_rules,
        requires_confirmation: row.requires_confirmation,
        last_opened_at: None,
        open_count: 0,
        indexed_at: now.to_string(),
        source_id: None,
        is_stale: row.is_stale,
        state_code: row.state_code,
    }
}

pub(crate) fn parent_directory(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    normalized
        .rsplit_once('/')
        .map(|(parent, _)| parent.to_string())
        .unwrap_or_default()
}

pub(crate) fn infer_file_type(extension: &str, is_dir: bool) -> &'static str {
    if is_dir {
        return "Other";
    }

    match extension.to_ascii_lowercase().as_str() {
        "pdf" | "doc" | "docx" | "txt" | "md" | "rtf" => "Document",
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "heic" | "svg" => "Image",
        "mp4" | "mov" | "mkv" | "avi" | "webm" => "Video",
        "mp3" | "wav" | "flac" | "aac" | "m4a" => "Audio",
        "zip" | "rar" | "7z" | "tar" | "gz" => "ArchivePackage",
        "exe" | "msi" | "dmg" | "pkg" | "appimage" => "Installer",
        "xls" | "xlsx" | "csv" | "numbers" => "Spreadsheet",
        "ppt" | "pptx" | "key" => "Presentation",
        "js" | "jsx" | "ts" | "tsx" | "rs" | "go" | "py" | "java" | "kt" | "swift" | "c"
        | "cpp" | "h" | "hpp" | "cs" | "php" | "rb" | "html" | "css" | "scss" | "json" | "yaml"
        | "yml" | "toml" => "Code",
        _ => "Other",
    }
}

pub(crate) fn unix_seconds_to_iso(seconds: i64) -> String {
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|time| time.format(&Rfc3339).ok())
        .unwrap_or_else(current_timestamp_iso)
}
