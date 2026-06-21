use crate::file_ops::OperationLogDto;
#[cfg(test)]
use rusqlite::{params, Connection, OptionalExtension};
#[cfg(test)]
use serde_json::Value;
#[cfg(test)]
use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};

mod classification;
mod connection;
mod queries;
mod schema;
mod types;
pub(crate) use classification::normalized_file_type;
#[cfg(test)]
pub(crate) use classification::{rule_version_for_rules, translate_template};
pub use connection::Database;
pub(crate) use queries::{
    bool_to_i64, current_unix_seconds, indexed_file_from_row, infer_file_type, normalize_path_text,
    optimize_search_index_after_bulk_upsert, parent_directory, path_lookup_candidates, push_unique,
    trim_trailing_path_separators, unix_seconds_to_iso,
};
#[cfg(test)]
pub(crate) use queries::{build_fts_query, upsert_files_by_paths_with_optional_optimize};
pub use queries::{
    emit_search_index_optimized, run_search_index_optimize, upsert_files_by_paths_for_db,
};
pub use types::*;

const CLASSIFY_BATCH_SIZE: usize = 500;
const OPTIMIZE_AFTER_UPSERT_THRESHOLD: usize = 500;
pub const SEARCH_INDEX_OPTIMIZED_EVENT: &str = "search-index-optimized";

const CLASSIFICATION_STATUS_UNCLASSIFIED: &str = "unclassified";
const CLASSIFICATION_STATUS_CLASSIFIED: &str = "classified";

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
) -> Result<Vec<FileSearchResult>, String> {
    db.search_files(&query, limit).map_err(command_error)
}

#[tauri::command]
pub fn get_paged_files(
    db: State<'_, Database>,
    limit: Option<u32>,
    offset: Option<u32>,
    query: Option<String>,
) -> Result<PagedFilesResult, String> {
    db.get_paged_files(limit, offset, query.as_deref())
        .map_err(command_error)
}

#[tauri::command]
pub fn get_stats_summary(db: State<'_, Database>) -> Result<StatsSummary, String> {
    db.get_stats_summary().map_err(command_error)
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

fn command_error(error: DbError) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::settings::{save_app_settings, AppSettings};

    #[test]
    fn translate_template_uses_chinese_folder_segments() {
        assert_eq!(
            translate_template("20_Areas/Personal/Identity", "zh"),
            "20_领域/个人/证件"
        );
        assert_eq!(
            translate_template("40_Archive/{year}/Study", "zh"),
            "40_归档/{year}/学业"
        );
        assert_eq!(
            translate_template("90_Temporary/Installers", "zh"),
            "90_临时/安装包"
        );
        assert_eq!(
            translate_template("20_Areas/Projects", "en"),
            "20_Areas/Projects"
        );
    }

    #[test]
    fn execute_rules_on_inbox_uses_persisted_chinese_folder_naming_for_new_classifications() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut settings = AppSettings::default();
        settings.folder_naming_language = "zh".to_string();
        save_app_settings(&db, &settings).expect("save app settings");
        insert_test_file(
            &db,
            "file-resume-zh",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        db.execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let file = page
            .files
            .iter()
            .find(|file| file.id == "file-resume-zh")
            .expect("classified file");

        assert!(file.suggested_target_path.contains("20_领域"));
        assert!(file.suggested_target_path.contains("职业"));
        assert!(!file.suggested_target_path.contains("20_Areas"));
        assert!(!file.suggested_target_path.contains("Career"));
    }

    #[test]
    fn get_paged_files_returns_limit_and_offset() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-1", "report.pdf", "pdf", 2_048, 1_800_000_000);
        insert_test_file(&db, "file-2", "photo.jpg", "jpg", 4_096, 1_900_000_000);

        let page = db.get_paged_files(Some(1), Some(1), None).expect("page");

        assert_eq!(page.total, 2);
        assert_eq!(page.limit, 1);
        assert_eq!(page.offset, 1);
        assert_eq!(page.files.len(), 1);
        assert_eq!(page.files[0].name, "report.pdf");
    }

    #[test]
    fn get_stats_summary_aggregates_files_and_types() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-1", "report.pdf", "pdf", 2_048, 1_800_000_000);
        insert_test_file(&db, "file-2", "photo.jpg", "jpg", 4_096, 1_900_000_000);

        let stats = db.get_stats_summary().expect("stats");

        assert_eq!(stats.total_files, 2);
        assert_eq!(stats.total_size, 6_144);
        assert_eq!(stats.by_type.get("Document"), Some(&1));
        assert_eq!(stats.by_type.get("Image"), Some(&1));
        assert_eq!(stats.by_lifecycle.get("Inbox"), Some(&2));
    }

    #[test]
    fn remove_files_by_paths_marks_file_stale() {
        let db = Database::open(test_db_path()).expect("open test database");
        db.insert_file(InsertFileRequest {
            id: "dir-project".to_string(),
            path: "/test/virtual/documents/project".to_string(),
            name: "project".to_string(),
            extension: String::new(),
            size: 0,
            mtime: 1_900_000_000,
            ctime: 0,
            is_dir: true,
            state_code: 0,
        })
        .expect("insert project directory");
        db.insert_file(InsertFileRequest {
            id: "file-ghost".to_string(),
            path: "/test/virtual/documents/project/ghost-report.pdf".to_string(),
            name: "ghost-report.pdf".to_string(),
            extension: "pdf".to_string(),
            size: 2_048,
            mtime: 1_900_000_001,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert child file");
        db.insert_file(InsertFileRequest {
            id: "file-survivor".to_string(),
            path: "/test/virtual/documents/project-other/survivor.pdf".to_string(),
            name: "survivor.pdf".to_string(),
            extension: "pdf".to_string(),
            size: 2_048,
            mtime: 1_900_000_002,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert sibling file");

        let removed = db
            .remove_files_by_paths(&["/test/virtual/documents/project".to_string()])
            .expect("remove paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let ghost_search = db.search_files("ghost-report", Some(10)).expect("search");

        assert_eq!(removed, 2);
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].id, "file-survivor");
        assert!(ghost_search.is_empty());
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/project"),
            Some((true, true))
        );
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/project/ghost-report.pdf"),
            Some((true, true))
        );
    }

    #[test]
    fn insert_files_revives_stale_file() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-report",
            "report.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        db.remove_files_by_paths(&["/test/virtual/documents/report.pdf".to_string()])
            .expect("mark stale");
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/report.pdf"),
            Some((true, true))
        );

        insert_test_file(
            &db,
            "file-report",
            "report.pdf",
            "pdf",
            4_096,
            1_900_000_100,
        );
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].id, "file-report");
        assert_eq!(page.files[0].size, 4_096);
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/report.pdf"),
            Some((false, true))
        );
    }

    #[test]
    fn search_files_excludes_stale_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-report",
            "report.txt",
            "txt",
            2_048,
            1_900_000_000,
        );

        let before = db.search_files("report", Some(10)).expect("search before");
        db.remove_files_by_paths(&["/test/virtual/documents/report.txt".to_string()])
            .expect("mark stale");
        let after = db.search_files("report", Some(10)).expect("search after");

        assert_eq!(before.len(), 1);
        assert!(after.is_empty());
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/report.txt"),
            Some((true, true))
        );
    }

    #[test]
    fn optimize_search_index_returns_duration() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-report",
            "report.txt",
            "txt",
            2_048,
            1_900_000_000,
        );

        let duration_ms = db.optimize_search_index().expect("optimize search index");
        let results = db.search_files("report", Some(10)).expect("search");

        assert!(duration_ms <= 60_000);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "report.txt");
    }

    #[test]
    fn run_search_index_optimize_reports_success() {
        let db = Database::open(test_db_path()).expect("open test database");

        let report = run_search_index_optimize("scan_complete", &db);

        assert_eq!(report.trigger, "scan_complete");
        assert!(report.success);
        assert!(report.duration_ms <= 60_000);
        assert!(report.error.is_none());
    }

    #[test]
    fn stats_excludes_stale_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-report",
            "report.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let before = db.get_stats_summary().expect("stats before");
        db.remove_files_by_paths(&["/test/virtual/documents/report.pdf".to_string()])
            .expect("mark stale");
        let after = db.get_stats_summary().expect("stats after");

        assert_eq!(before.total_files, 1);
        assert_eq!(before.total_size, 2_048);
        assert_eq!(after.total_files, 0);
        assert_eq!(after.total_size, 0);
        assert_eq!(
            stale_state(&db, "/test/virtual/documents/report.pdf"),
            Some((true, true))
        );
    }

    #[test]
    fn execute_rules_ignores_stale_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-stale",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        db.remove_files_by_paths(&["/test/virtual/documents/resume_2026.pdf".to_string()])
            .expect("mark stale");

        let summary = db
            .execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let row = file_classification(&db, "/test/virtual/documents/resume_2026.pdf")
            .expect("stale file still exists");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
        assert_eq!(row, ("Unknown".to_string(), "Inbox".to_string(), true));
    }

    #[test]
    fn execute_rules_for_paths_classifies_only_target_paths() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-target",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        insert_test_file(
            &db,
            "file-invoice-untouched",
            "invoice_apple.pdf",
            "pdf",
            2_048,
            1_900_000_001,
        );

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/resume_2026.pdf".to_string()],
                Vec::new(),
            )
            .expect("execute targeted rules");
        let target = file_classification(&db, "/test/virtual/documents/resume_2026.pdf")
            .expect("target file");
        let untouched = file_classification(&db, "/test/virtual/documents/invoice_apple.pdf")
            .expect("untouched file");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(
            target,
            ("Career".to_string(), "Reference".to_string(), false)
        );
        assert_eq!(
            untouched,
            ("Unknown".to_string(), "Inbox".to_string(), false)
        );
    }

    #[test]
    fn execute_rules_for_paths_ignores_missing_paths() {
        let db = Database::open(test_db_path()).expect("open test database");

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/missing.pdf".to_string()],
                Vec::new(),
            )
            .expect("execute targeted rules");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
        assert_eq!(summary.needs_confirmation, 0);
    }

    #[test]
    fn execute_rules_for_paths_ignores_stale_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-stale-target",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        db.remove_files_by_paths(&["/test/virtual/documents/resume_2026.pdf".to_string()])
            .expect("mark stale");

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/resume_2026.pdf".to_string()],
                Vec::new(),
            )
            .expect("execute targeted rules");
        let row = file_classification(&db, "/test/virtual/documents/resume_2026.pdf")
            .expect("stale file still exists");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
        assert_eq!(row, ("Unknown".to_string(), "Inbox".to_string(), true));
    }

    #[test]
    fn execute_rules_for_paths_ignores_non_inbox_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-archive",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        set_file_lifecycle(&db, "/test/virtual/documents/resume_2026.pdf", "Archive");

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/resume_2026.pdf".to_string()],
                Vec::new(),
            )
            .expect("execute targeted rules");
        let row = file_classification(&db, "/test/virtual/documents/resume_2026.pdf")
            .expect("archive file");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
        assert_eq!(row, ("Unknown".to_string(), "Archive".to_string(), false));
    }

    #[test]
    fn execute_rules_on_inbox_skips_unchanged_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-plain", "plain.tmp", "tmp", 2_048, 1_900_000_000);

        let first = db.execute_rules_on_inbox(Vec::new()).expect("first rules");
        let second = db.execute_rules_on_inbox(Vec::new()).expect("second rules");

        assert_eq!(first.scanned, 1);
        assert_eq!(first.updated, 1);
        assert_eq!(first.skipped, 0);
        assert_eq!(second.scanned, 1);
        assert_eq!(second.updated, 0);
        assert_eq!(second.skipped, 1);
    }

    #[test]
    fn execute_rules_on_inbox_reclassifies_when_rule_changes() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-special",
            "special_project.txt",
            "txt",
            2_048,
            1_900_000_000,
        );

        let first = db
            .execute_rules_on_inbox(vec![name_contains_rule(
                "special-rule-a",
                "Special A",
                "Project",
            )])
            .expect("first rules");
        let first_fingerprint =
            classification_fingerprint(&db, "/test/virtual/documents/special_project.txt")
                .expect("first fingerprint");
        let second = db
            .execute_rules_on_inbox(vec![name_contains_rule(
                "special-rule-b",
                "Special B",
                "Career",
            )])
            .expect("second rules");
        let second_fingerprint =
            classification_fingerprint(&db, "/test/virtual/documents/special_project.txt")
                .expect("second fingerprint");

        assert_eq!(first.updated, 1);
        assert_eq!(second.scanned, 1);
        assert_eq!(second.updated, 1);
        assert_eq!(second.skipped, 0);
        assert_ne!(first_fingerprint.1, second_fingerprint.1);
    }

    #[test]
    fn execute_rules_on_inbox_reclassifies_when_file_mtime_changes() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-plain", "plain.tmp", "tmp", 2_048, 1_900_000_000);

        db.execute_rules_on_inbox(Vec::new()).expect("first rules");
        set_file_mtime(&db, "/test/virtual/documents/plain.tmp", 1_900_000_100);
        let second = db.execute_rules_on_inbox(Vec::new()).expect("second rules");
        let fingerprint = classification_fingerprint(&db, "/test/virtual/documents/plain.tmp")
            .expect("fingerprint");

        assert_eq!(second.scanned, 1);
        assert_eq!(second.updated, 1);
        assert_eq!(second.skipped, 0);
        assert_eq!(fingerprint.2, 1_900_000_100);
    }

    #[test]
    fn execute_rules_on_inbox_reclassifies_when_file_size_changes() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(&db, "file-plain", "plain.tmp", "tmp", 2_048, 1_900_000_000);

        db.execute_rules_on_inbox(Vec::new()).expect("first rules");
        set_file_size(&db, "/test/virtual/documents/plain.tmp", 4_096);
        let second = db.execute_rules_on_inbox(Vec::new()).expect("second rules");
        let fingerprint = classification_fingerprint(&db, "/test/virtual/documents/plain.tmp")
            .expect("fingerprint");

        assert_eq!(second.scanned, 1);
        assert_eq!(second.updated, 1);
        assert_eq!(second.skipped, 0);
        assert_eq!(fingerprint.3, 4_096);
    }

    #[test]
    fn execute_rules_for_paths_sets_classification_fingerprint() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-target",
            "target.tmp",
            "tmp",
            4_096,
            1_900_000_000,
        );

        let summary = db
            .execute_rules_for_paths(
                &["/test/virtual/documents/target.tmp".to_string()],
                Vec::new(),
            )
            .expect("targeted rules");
        let fingerprint = classification_fingerprint(&db, "/test/virtual/documents/target.tmp")
            .expect("fingerprint");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(summary.skipped, 0);
        assert!(fingerprint.0 > 0);
        assert!(!fingerprint.1.is_empty());
        assert_eq!(fingerprint.2, 1_900_000_000);
        assert_eq!(fingerprint.3, 4_096);
    }

    #[test]
    fn rule_version_is_stable_for_same_rules() {
        let rules = vec![
            name_contains_rule("special-rule-a", "Special A", "Project"),
            name_contains_rule("special-rule-b", "Special B", "Career"),
        ];

        let first = rule_version_for_rules(&rules).expect("first version");
        let second = rule_version_for_rules(&rules).expect("second version");

        assert_eq!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.chars().all(|character| character.is_ascii_hexdigit()));
    }

    #[test]
    fn rule_version_ignores_user_rule_order() {
        let rule_a = name_contains_rule("special-rule-a", "Special A", "Project");
        let rule_b = name_contains_rule("special-rule-b", "Special B", "Career");

        let first =
            rule_version_for_rules(&[rule_a.clone(), rule_b.clone()]).expect("first version");
        let second = rule_version_for_rules(&[rule_b, rule_a]).expect("second version");

        assert_eq!(first, second);
    }

    #[test]
    fn rule_version_changes_when_rule_content_changes() {
        let mut changed_rule = name_contains_rule("special-rule-a", "Special A", "Project");
        let original = rule_version_for_rules(&[changed_rule.clone()]).expect("original version");

        changed_rule.weight = 50.0;
        let changed = rule_version_for_rules(&[changed_rule]).expect("changed version");

        assert_ne!(original, changed);
    }

    #[test]
    fn save_user_rule_round_trips_rule() {
        let db = Database::open(test_db_path()).expect("open test database");
        let rule = user_rule_for_persistence("rule-round-trip", "Round Trip", 300.0);

        let saved = db.save_user_rule(rule.clone()).expect("save user rule");
        let rules = db.get_user_rules().expect("get user rules");

        assert_eq!(saved.id, rule.id);
        assert_eq!(saved.source, "user");
        assert_eq!(rules.len(), 1);
        assert_rule_matches(&rules[0], &saved);
        assert_eq!(rules[0].groups.len(), 1);
        assert_eq!(rules[0].groups[0].operator, "AND");
        assert_eq!(rules[0].groups[0].conditions[0].field, "extension");
        assert_eq!(
            rules[0].groups[0].conditions[0].value,
            Value::String("pdf".to_string())
        );
        assert_eq!(rules[0].action.lifecycle.as_deref(), Some("Archive"));
        assert_eq!(
            rules[0].action.target_template.as_deref(),
            Some("{home}/Archive")
        );
    }

    #[test]
    fn save_user_rule_forces_source_user() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut rule = user_rule_for_persistence("rule-source", "Source", 200.0);
        rule.source = "system".to_string();

        let saved = db.save_user_rule(rule).expect("save user rule");
        let rules = db.get_user_rules().expect("get user rules");

        assert_eq!(saved.source, "user");
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].source, "user");
    }

    #[test]
    fn save_user_rule_updates_existing_rule() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut rule = user_rule_for_persistence("rule-update", "Before", 100.0);
        db.save_user_rule(rule.clone()).expect("save initial rule");

        rule.name = "After".to_string();
        rule.enabled = false;
        rule.action.lifecycle = Some("TrashReview".to_string());
        let saved = db.save_user_rule(rule.clone()).expect("update rule");
        let rules = db.get_user_rules().expect("get user rules");

        assert_eq!(rules.len(), 1);
        assert_eq!(saved.name, "After");
        assert!(!rules[0].enabled);
        assert_eq!(rules[0].action.lifecycle.as_deref(), Some("TrashReview"));
    }

    #[test]
    fn get_user_rules_orders_by_priority() {
        let db = Database::open(test_db_path()).expect("open test database");
        db.save_user_rule(user_rule_for_persistence("rule-low", "Low", 10.0))
            .expect("save low rule");
        db.save_user_rule(user_rule_for_persistence("rule-high", "High", 900.0))
            .expect("save high rule");
        db.save_user_rule(user_rule_for_persistence("rule-mid", "Mid", 100.0))
            .expect("save mid rule");

        let rules = db.get_user_rules().expect("get user rules");
        let ids = rules
            .iter()
            .map(|rule| rule.id.as_str())
            .collect::<Vec<_>>();

        assert_eq!(ids, vec!["rule-high", "rule-mid", "rule-low"]);
    }

    #[test]
    fn delete_user_rule_removes_user_rule() {
        let db = Database::open(test_db_path()).expect("open test database");
        db.save_user_rule(user_rule_for_persistence("rule-delete", "Delete", 100.0))
            .expect("save user rule");

        let deleted = db
            .delete_user_rule("rule-delete")
            .expect("delete user rule");
        let rules = db.get_user_rules().expect("get user rules");

        assert!(deleted);
        assert!(rules.iter().all(|rule| rule.id != "rule-delete"));
    }

    #[test]
    fn delete_user_rule_ignores_missing_rule() {
        let db = Database::open(test_db_path()).expect("open test database");

        let deleted = db
            .delete_user_rule("missing-rule")
            .expect("delete missing rule");

        assert!(!deleted);
    }

    #[test]
    fn delete_user_rule_does_not_delete_non_user_rule() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_system_rule_row(&db, "system-rule");

        let deleted = db
            .delete_user_rule("system-rule")
            .expect("delete system rule");
        let source = rule_source_by_id(&db, "system-rule").expect("system rule row");

        assert!(!deleted);
        assert_eq!(source, "system");
    }

    #[test]
    fn upsert_files_by_paths_inserts_new_file() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let file = root.join("new-report.txt");
        fs::write(&file, "hello").expect("write file");

        let upserted = upsert_files_by_paths_for_db(&db, &[file.to_string_lossy().into_owned()])
            .expect("upsert paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(upserted, 1);
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].name, "new-report.txt");
        assert_eq!(page.files[0].path, normalized_test_path(&file));
        assert!(!page.files[0].is_stale);
    }

    #[test]
    fn upsert_files_by_paths_updates_modified_file() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let file = root.join("notes.txt");
        fs::write(&file, "old").expect("write file");
        let path = normalized_test_path(&file);
        db.insert_file(InsertFileRequest {
            id: path.clone(),
            path: path.clone(),
            name: "notes.txt".to_string(),
            extension: "txt".to_string(),
            size: 3,
            mtime: 1,
            ctime: 1,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert old file");
        fs::write(&file, "new content").expect("modify file");

        let upserted = upsert_files_by_paths_for_db(&db, &[file.to_string_lossy().into_owned()])
            .expect("upsert paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(upserted, 1);
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].size, 11);
        assert!(page.files[0].modified_at.len() > 0);
    }

    #[test]
    fn upsert_files_by_paths_revives_stale_file() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let file = root.join("revived.txt");
        fs::write(&file, "hello").expect("write file");
        let path = normalized_test_path(&file);
        db.insert_file(InsertFileRequest {
            id: path.clone(),
            path: path.clone(),
            name: "revived.txt".to_string(),
            extension: "txt".to_string(),
            size: 5,
            mtime: 1,
            ctime: 1,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert file");
        db.remove_files_by_paths(&[path.clone()])
            .expect("mark stale");

        let upserted = upsert_files_by_paths_for_db(&db, &[file.to_string_lossy().into_owned()])
            .expect("upsert paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(upserted, 1);
        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].path, path);
        assert_eq!(stale_state(&db, &page.files[0].path), Some((false, true)));
    }

    #[test]
    fn upsert_files_by_paths_ignores_missing_path() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let missing = root.join("missing.txt");

        let upserted = upsert_files_by_paths_for_db(&db, &[missing.to_string_lossy().into_owned()])
            .expect("upsert paths");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");

        assert_eq!(upserted, 0);
        assert_eq!(page.total, 0);
    }

    #[test]
    fn upsert_files_by_paths_with_optional_optimize_handles_large_batch() {
        let db = Database::open(test_db_path()).expect("open test database");
        let root = test_dir();
        let mut paths = Vec::with_capacity(OPTIMIZE_AFTER_UPSERT_THRESHOLD);
        for index in 0..OPTIMIZE_AFTER_UPSERT_THRESHOLD {
            let file = root.join(format!("large-upsert-{index:04}.txt"));
            fs::write(&file, format!("file {index}")).expect("write file");
            paths.push(file.to_string_lossy().into_owned());
        }

        let upserted =
            upsert_files_by_paths_with_optional_optimize(&db, &paths).expect("upsert paths");
        let page = db.get_paged_files(Some(1), Some(0), None).expect("page");

        assert_eq!(upserted, OPTIMIZE_AFTER_UPSERT_THRESHOLD);
        assert_eq!(page.total, OPTIMIZE_AFTER_UPSERT_THRESHOLD as i64);
    }

    #[test]
    fn execute_rules_updates_inbox_resume_classification() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let summary = db
            .execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let file = page
            .files
            .iter()
            .find(|file| file.id == "file-resume")
            .expect("classified file");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(file.purpose, "Career");
        assert_eq!(file.lifecycle, "Reference");
        assert_eq!(file.suggested_action, "Move");
        assert!(file.confidence >= 0.8);
        assert!(file
            .matched_rules
            .iter()
            .any(|rule| rule.contains("Career")));
        assert_ne!(
            file.classification_reason,
            "Indexed by Zen Canvas Tauri backend."
        );
    }

    #[test]
    fn file_records_expose_classification_status_for_unclassified_and_classified_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-status-resume",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let unclassified = page
            .files
            .iter()
            .find(|file| file.id == "file-status-resume")
            .expect("unclassified file");

        assert_eq!(unclassified.classification_status, "unclassified");

        db.execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let classified = page
            .files
            .iter()
            .find(|file| file.id == "file-status-resume")
            .expect("classified file");

        assert_eq!(classified.classification_status, "classified");
    }

    #[test]
    fn execute_rules_marks_finance_files_sensitive_review_only() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-invoice",
            "invoice_apple.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let summary = db
            .execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let file = page
            .files
            .iter()
            .find(|file| file.id == "file-invoice")
            .expect("classified file");

        assert_eq!(summary.needs_confirmation, 1);
        assert_eq!(file.purpose, "Finance");
        assert_eq!(file.risk_level, "Sensitive");
        assert_eq!(file.suggested_action, "Review");
        assert!(file.requires_confirmation);
    }

    #[test]
    fn execute_rules_accepts_user_rules_that_override_builtins() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-resume-project",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let user_rule = Rule {
            id: "user_resume_project".to_string(),
            name: "Resume project override".to_string(),
            source: "user".to_string(),
            enabled: true,
            priority: 150.0,
            weight: 96.0,
            root_operator: "OR".to_string(),
            groups: vec![RuleConditionGroup {
                id: "resume_project_group".to_string(),
                operator: "AND".to_string(),
                conditions: vec![RuleCondition {
                    id: "resume_name".to_string(),
                    field: "name".to_string(),
                    operator: "contains".to_string(),
                    value: Value::String("resume".to_string()),
                }],
            }],
            action: RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                context: Some("Override".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                rename_template: None,
            },
            created_at: String::new(),
            updated_at: String::new(),
        };

        db.execute_rules_on_inbox(vec![user_rule])
            .expect("execute rules");
        let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
        let file = page
            .files
            .iter()
            .find(|file| file.id == "file-resume-project")
            .expect("classified file");

        assert_eq!(file.purpose, "Project");
        assert_eq!(file.lifecycle, "Active");
        assert!(file
            .matched_rules
            .iter()
            .any(|rule| rule == "Resume project override"));
    }

    #[test]
    fn search_files_matches_chinese_substrings_with_trigram() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file(
            &db,
            "file-cn",
            "项目报告2026_final.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );

        let results = db.search_files("报告2026", Some(10)).expect("search");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "项目报告2026_final.pdf");
    }

    #[test]
    fn operation_log_tables_exist_after_migration() {
        let db = Database::open(test_db_path()).expect("open test database");
        let conn = Connection::open(db.path()).expect("open migrated database");

        let table_count: i64 = conn
            .query_row(
                r#"
                SELECT COUNT(*)
                FROM sqlite_schema
                WHERE type = 'table'
                  AND name IN ('operation_batches', 'operation_logs')
                "#,
                [],
                |row| row.get(0),
            )
            .expect("count operation tables");

        assert_eq!(table_count, 2);
    }

    #[test]
    fn get_operation_logs_returns_empty_array_for_empty_table() {
        let db = Database::open(test_db_path()).expect("open test database");

        let logs = db.get_operation_logs(Some(500)).expect("operation logs");

        assert!(logs.is_empty());
    }

    #[test]
    fn save_operation_logs_persists_success_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let log = operation_log("log-success", "batch-success", "success");

        db.save_operation_logs("batch-success", &[log.clone()])
            .expect("save operation logs");
        let logs = db.get_operation_logs(Some(10)).expect("operation logs");

        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].id, log.id);
        assert_eq!(logs[0].batch_id, "batch-success");
        assert_eq!(logs[0].status, "success");
        assert!(logs[0].can_restore);
        assert_eq!(operation_batch_status(&db, "batch-success"), "success");
    }

    #[test]
    fn save_operation_logs_persists_failed_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-failed", "batch-failed", "failed");
        log.error_message = Some("Source file does not exist.".to_string());
        log.can_undo = false;
        log.can_restore = false;

        db.save_operation_logs("batch-failed", &[log.clone()])
            .expect("save operation logs");
        let logs = db.get_operation_logs(Some(10)).expect("operation logs");

        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].status, "failed");
        assert_eq!(
            logs[0].error_message.as_deref(),
            Some("Source file does not exist.")
        );
        assert!(!logs[0].can_restore);
        assert_eq!(
            operation_batch_status(&db, "batch-failed"),
            "partial_failed"
        );
    }

    #[test]
    fn save_operation_logs_persists_skipped_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-skipped", "batch-skipped", "skipped");
        log.error_message = Some("Operation is not executable.".to_string());
        log.can_undo = false;
        log.can_restore = false;

        db.save_operation_logs("batch-skipped", &[log.clone()])
            .expect("save operation logs");
        let logs = db.get_operation_logs(Some(10)).expect("operation logs");

        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].status, "skipped");
        assert_eq!(
            logs[0].error_message.as_deref(),
            Some("Operation is not executable.")
        );
        assert!(!logs[0].can_restore);
        assert_eq!(operation_batch_status(&db, "batch-skipped"), "success");
    }

    #[test]
    fn update_operation_restore_logs_marks_restored_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-restored", "batch-restored", "success");
        db.save_operation_logs("batch-restored", &[log.clone()])
            .expect("save operation logs");

        log.can_undo = false;
        log.can_restore = false;
        log.restored_at = Some("1900000000999".to_string());
        log.restore_status = "restored".to_string();
        log.restore_error = None;
        db.update_operation_restore_logs(&[log])
            .expect("update restore logs");

        let logs = db.get_operation_logs(Some(10)).expect("operation logs");
        assert_eq!(logs[0].restore_status, "restored");
        assert!(!logs[0].can_restore);
        assert!(!logs[0].can_undo);
        assert_eq!(logs[0].restored_at.as_deref(), Some("1900000000999"));
        assert!(logs[0].restore_error.is_none());
    }

    #[test]
    fn update_operation_restore_logs_marks_failed_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-restore-failed", "batch-restore-failed", "success");
        db.save_operation_logs("batch-restore-failed", &[log.clone()])
            .expect("save operation logs");

        log.restore_status = "failed".to_string();
        log.restore_error = Some("Target file already exists.".to_string());
        db.update_operation_restore_logs(&[log])
            .expect("update restore logs");

        let logs = db.get_operation_logs(Some(10)).expect("operation logs");
        assert_eq!(logs[0].restore_status, "failed");
        assert_eq!(
            logs[0].restore_error.as_deref(),
            Some("Target file already exists.")
        );
    }

    #[test]
    fn update_operation_restore_logs_marks_unavailable_log() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut log = operation_log("log-unavailable", "batch-unavailable", "skipped");
        log.can_undo = false;
        log.can_restore = false;
        db.save_operation_logs("batch-unavailable", &[log.clone()])
            .expect("save operation logs");

        log.restore_status = "unavailable".to_string();
        log.restore_error = Some("Only successful operations can be restored.".to_string());
        db.update_operation_restore_logs(&[log])
            .expect("update restore logs");

        let logs = db.get_operation_logs(Some(10)).expect("operation logs");
        assert_eq!(logs[0].restore_status, "unavailable");
        assert!(!logs[0].can_restore);
        assert_eq!(
            logs[0].restore_error.as_deref(),
            Some("Only successful operations can be restored.")
        );
    }

    #[test]
    fn build_fts_query_quotes_terms_without_breaking_chinese_or_punctuation() {
        let query = build_fts_query("项目\"报告 final-v1.pdf").expect("query");

        assert_eq!(query, "\"项目\"\"报告\" AND \"final-v1.pdf\"");
    }

    fn insert_test_file(
        db: &Database,
        id: &str,
        name: &str,
        extension: &str,
        size: i64,
        mtime: i64,
    ) {
        db.insert_file(InsertFileRequest {
            id: id.to_string(),
            path: format!("/test/virtual/documents/{name}"),
            name: name.to_string(),
            extension: extension.to_string(),
            size,
            mtime,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert file");
    }

    fn operation_log(id: &str, batch_id: &str, status: &str) -> OperationLogDto {
        let success = status == "success";
        OperationLogDto {
            id: id.to_string(),
            batch_id: batch_id.to_string(),
            operation_type: "move".to_string(),
            source_path: "/tmp/source.txt".to_string(),
            target_path: "/tmp/target.txt".to_string(),
            old_name: "source.txt".to_string(),
            new_name: "target.txt".to_string(),
            status: status.to_string(),
            error_message: None,
            created_at: "1900000000123".to_string(),
            can_undo: success,
            path_before: "/tmp/source.txt".to_string(),
            path_after: "/tmp/target.txt".to_string(),
            name_before: "source.txt".to_string(),
            name_after: "target.txt".to_string(),
            can_restore: success,
            restored_at: None,
            restore_status: "not_restored".to_string(),
            restore_error: None,
        }
    }

    fn operation_batch_status(db: &Database, batch_id: &str) -> String {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            "SELECT status FROM operation_batches WHERE id = ?1",
            params![batch_id],
            |row| row.get(0),
        )
        .expect("operation batch status")
    }

    fn stale_state(db: &Database, path: &str) -> Option<(bool, bool)> {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            "SELECT is_stale, last_seen_at FROM files WHERE path = ?1",
            params![path],
            |row| Ok((row.get::<_, i64>(0)? != 0, row.get::<_, i64>(1)? > 0)),
        )
        .optional()
        .expect("stale state")
    }

    fn file_classification(db: &Database, path: &str) -> Option<(String, String, bool)> {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            "SELECT purpose, lifecycle, is_stale FROM files WHERE path = ?1",
            params![path],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .expect("file classification")
    }

    fn set_file_lifecycle(db: &Database, path: &str, lifecycle: &str) {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            "UPDATE files SET lifecycle = ?2 WHERE path = ?1",
            params![path, lifecycle],
        )
        .expect("set lifecycle");
    }

    fn set_file_mtime(db: &Database, path: &str, mtime: i64) {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            "UPDATE files SET mtime = ?2 WHERE path = ?1",
            params![path, mtime],
        )
        .expect("set mtime");
    }

    fn set_file_size(db: &Database, path: &str, size: i64) {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            "UPDATE files SET size = ?2 WHERE path = ?1",
            params![path, size],
        )
        .expect("set size");
    }

    fn classification_fingerprint(db: &Database, path: &str) -> Option<(i64, String, i64, i64)> {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            r#"
            SELECT last_classified_at,
                   classified_rule_version,
                   last_classified_mtime,
                   last_classified_size
            FROM files
            WHERE path = ?1
            "#,
            params![path],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()
        .expect("classification fingerprint")
    }

    fn name_contains_rule(id: &str, name: &str, purpose: &str) -> Rule {
        Rule {
            id: id.to_string(),
            name: name.to_string(),
            source: "user".to_string(),
            enabled: true,
            priority: 200.0,
            weight: 100.0,
            root_operator: "OR".to_string(),
            groups: vec![RuleConditionGroup {
                id: format!("{id}-group"),
                operator: "AND".to_string(),
                conditions: vec![RuleCondition {
                    id: format!("{id}-condition"),
                    field: "name".to_string(),
                    operator: "contains".to_string(),
                    value: Value::String("special".to_string()),
                }],
            }],
            action: RuleAction {
                purpose: Some(purpose.to_string()),
                lifecycle: Some("Inbox".to_string()),
                context: Some("D1 Test".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Keep".to_string()),
                target_template: None,
                rename_template: None,
            },
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn user_rule_for_persistence(id: &str, name: &str, priority: f64) -> Rule {
        Rule {
            id: id.to_string(),
            name: name.to_string(),
            source: "user".to_string(),
            enabled: true,
            priority,
            weight: 42.5,
            root_operator: "AND".to_string(),
            groups: vec![RuleConditionGroup {
                id: format!("{id}-group"),
                operator: "AND".to_string(),
                conditions: vec![RuleCondition {
                    id: format!("{id}-condition"),
                    field: "extension".to_string(),
                    operator: "equals".to_string(),
                    value: Value::String("pdf".to_string()),
                }],
            }],
            action: RuleAction {
                purpose: Some("Document".to_string()),
                lifecycle: Some("Archive".to_string()),
                context: Some("Persistence Test".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("{home}/Archive".to_string()),
                rename_template: Some("{name}".to_string()),
            },
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    fn assert_rule_matches(actual: &Rule, expected: &Rule) {
        assert_eq!(actual.id, expected.id);
        assert_eq!(actual.name, expected.name);
        assert_eq!(actual.source, "user");
        assert_eq!(actual.enabled, expected.enabled);
        assert_eq!(actual.priority, expected.priority);
        assert_eq!(actual.weight, expected.weight);
        assert_eq!(actual.root_operator, expected.root_operator);
        assert_eq!(
            serde_json::to_value(&actual.groups).expect("actual groups json"),
            serde_json::to_value(&expected.groups).expect("expected groups json")
        );
        assert_eq!(
            serde_json::to_value(&actual.action).expect("actual action json"),
            serde_json::to_value(&expected.action).expect("expected action json")
        );
        assert!(!actual.created_at.is_empty());
        assert!(!actual.updated_at.is_empty());
    }

    fn insert_system_rule_row(db: &Database, id: &str) {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            r#"
            INSERT INTO rules (
                id,
                name,
                source,
                enabled,
                priority,
                weight,
                root_operator,
                groups_json,
                action_json,
                created_at,
                updated_at
            )
            VALUES (?1, 'System Rule', 'system', 1, 1000, 100, 'AND', '[]', '{}', '2026-06-21T00:00:00Z', '2026-06-21T00:00:00Z')
            "#,
            params![id],
        )
        .expect("insert system rule row");
    }

    fn rule_source_by_id(db: &Database, id: &str) -> Option<String> {
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.query_row(
            "SELECT source FROM rules WHERE id = ?1",
            params![id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .expect("rule source")
    }

    fn test_db_path() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("zen-canvas-db-test-{nonce}.sqlite3"))
    }

    fn test_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let dir = std::env::temp_dir().join(format!("zen-canvas-db-file-test-{nonce}"));
        fs::create_dir_all(&dir).expect("test dir");
        dir
    }

    fn normalized_test_path(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }
}
