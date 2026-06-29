    #[test]
    fn app_settings_defaults_include_search_scope_settings() {
        let settings = AppSettings::default();

        assert_eq!(settings.search_hotkey, "CmdOrCtrl+K");
        assert_eq!(settings.search_scope_mode, "all");
        assert!(settings.custom_search_roots.is_empty());
    }

    #[test]
    fn app_settings_deserializes_legacy_json_with_search_scope_defaults() {
        let settings: AppSettings = serde_json::from_value(serde_json::json!({
            "closeBehavior": "ask",
            "folderNamingLanguage": "en",
            "defaultScanFolders": [],
            "restoreRetentionDays": 30,
            "launchAtLogin": false
        }))
        .expect("legacy settings deserialize");

        assert_eq!(settings.search_hotkey, "CmdOrCtrl+K");
        assert_eq!(settings.search_scope_mode, "all");
        assert!(settings.custom_search_roots.is_empty());
    }

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
    fn folder_naming_language_change_rebuilds_existing_media_suggestion_path() {
        let db = Database::open(test_db_path()).expect("open test database");
        let mut settings = AppSettings::default();
        settings.folder_naming_language = "en".to_string();
        save_app_settings(&db, &settings).expect("save english settings");
        insert_test_file(
            &db,
            "file-photo-language",
            "photo_001.jpg",
            "jpg",
            2_048,
            1_900_000_000,
        );

        db.execute_rules_on_inbox(Vec::new())
            .expect("execute english rules");
        let english_path = db
            .get_paged_files(Some(10), Some(0), None)
            .expect("english page")
            .files
            .into_iter()
            .find(|file| file.id == "file-photo-language")
            .expect("english file")
            .suggested_target_path
            .replace('\\', "/");

        settings.folder_naming_language = "zh".to_string();
        save_app_settings(&db, &settings).expect("save chinese settings");
        set_file_lifecycle(&db, "/test/virtual/documents/photo_001.jpg", "Inbox");
        let summary = db.execute_rules_for_paths(
            &["/test/virtual/documents/photo_001.jpg".to_string()],
            Vec::new(),
        )
        .expect("execute chinese rules");
        let chinese_path = db
            .get_paged_files(Some(10), Some(0), None)
            .expect("chinese page")
            .files
            .into_iter()
            .find(|file| file.id == "file-photo-language")
            .expect("chinese file")
            .suggested_target_path
            .replace('\\', "/");

        assert!(english_path.contains("20_Areas/Media/Images"));
        assert_eq!(summary.updated, 1);
        assert!(chinese_path.contains("20_领域/媒体/图片"));
        assert_ne!(english_path, chinese_path);
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
    fn migrated_schema_contains_common_library_performance_indexes() {
        let db = Database::open(test_db_path()).expect("open test database");
        let conn = Connection::open(db.path()).expect("open migrated database");
        let mut stmt = conn
            .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'files'")
            .expect("prepare index query");
        let index_names = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .expect("query index names")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect index names");

        for expected in [
            "idx_files_active_mtime",
            "idx_files_lifecycle_mtime",
            "idx_files_action_mtime",
            "idx_files_review_mtime",
            "idx_files_risk_mtime",
            "idx_files_scope_path",
        ] {
            assert!(
                index_names.iter().any(|name| name == expected),
                "missing performance index {expected}; indexes were {index_names:?}"
            );
        }
    }

    #[test]
    fn get_paged_files_filters_by_library_scope_roots() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file_at_path(
            &db,
            "file-root-a",
            "/tmp/root-a/a.pdf",
            "a.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        insert_test_file_at_path(
            &db,
            "file-root-b",
            "/tmp/root-b/b.pdf",
            "b.pdf",
            "pdf",
            4_096,
            1_900_000_001,
        );

        let root_a = LibraryScope::Roots {
            roots: vec!["/tmp/root-a".to_string()],
        };
        let root_b = LibraryScope::Roots {
            roots: vec!["/tmp/root-b".to_string()],
        };
        let all = LibraryScope::All;

        let page_a = db
            .get_paged_files_in_scope(Some(10), Some(0), None, &root_a)
            .expect("root a page");
        let page_b = db
            .get_paged_files_in_scope(Some(10), Some(0), None, &root_b)
            .expect("root b page");
        let page_all = db
            .get_paged_files_in_scope(Some(10), Some(0), None, &all)
            .expect("all page");

        assert_eq!(page_a.total, 1);
        assert_eq!(page_a.files[0].name, "a.pdf");
        assert_eq!(page_b.total, 1);
        assert_eq!(page_b.files[0].name, "b.pdf");
        assert_eq!(page_all.total, 2);
    }

    #[test]
    fn get_paged_files_filters_review_files_and_search_query_together() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file_at_path(
            &db,
            "file-review-pdf",
            "/tmp/root-a/invoice_review.pdf",
            "invoice_review.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        insert_test_file_at_path(
            &db,
            "file-review-image",
            "/tmp/root-a/invoice_review.png",
            "invoice_review.png",
            "png",
            2_048,
            1_900_000_001,
        );
        insert_test_file_at_path(
            &db,
            "file-active-pdf",
            "/tmp/root-a/project_invoice.pdf",
            "project_invoice.pdf",
            "pdf",
            2_048,
            1_900_000_002,
        );
        set_file_review_state(
            &db,
            "/tmp/root-a/invoice_review.pdf",
            "Inbox",
            "Review",
            true,
        );
        set_file_review_state(
            &db,
            "/tmp/root-a/invoice_review.png",
            "Inbox",
            "Review",
            true,
        );
        set_file_review_state(
            &db,
            "/tmp/root-a/project_invoice.pdf",
            "Active",
            "Keep",
            false,
        );

        let page = db
            .get_paged_files_in_scope_with_filter(
                Some(10),
                Some(0),
                Some("pdf"),
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                Some(&FileLibraryFilter {
                    library_filter: Some(LibraryFilter::Review),
                }),
            )
            .expect("review pdf page");

        assert_eq!(page.total, 1);
        assert_eq!(page.files[0].id, "file-review-pdf");
    }

    #[test]
    fn get_paged_files_query_plan_is_available_for_benchmark_diagnostics() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file_at_path(
            &db,
            "file-review-pdf",
            "/tmp/root-a/invoice_review.pdf",
            "invoice_review.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        set_file_review_state(
            &db,
            "/tmp/root-a/invoice_review.pdf",
            "Inbox",
            "Review",
            true,
        );

        let plan = db
            .explain_paged_files_query_plan(
                Some("invoice"),
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                Some(&FileLibraryFilter {
                    library_filter: Some(LibraryFilter::Review),
                }),
            )
            .expect("query plan");

        assert!(
            plan.iter().any(|line| line.contains("files_fts") || line.contains("idx_files")),
            "query plan should mention the FTS table or files indexes: {plan:?}"
        );
    }

    #[test]
    fn get_paged_files_filters_library_buckets() {
        let db = Database::open(test_db_path()).expect("open test database");
        let samples = [
            ("file-active", "active.txt", "txt"),
            ("file-reference", "reference.txt", "txt"),
            ("file-keep", "keep.txt", "txt"),
            ("file-archive", "archive.txt", "txt"),
            ("file-review", "review.txt", "txt"),
            ("file-delete-candidate", "delete-candidate.txt", "txt"),
            ("file-duplicate-a", "duplicate-a.txt", "txt"),
            ("file-duplicate-b", "duplicate-b.txt", "txt"),
            ("file-sensitive", "passport.pdf", "pdf"),
        ];
        for (index, (id, name, extension)) in samples.into_iter().enumerate() {
            insert_test_file_at_path(
                &db,
                id,
                &format!("/tmp/root-a/{name}"),
                name,
                extension,
                2_048,
                1_900_000_000 + index as i64,
            );
        }
        set_file_review_state(&db, "/tmp/root-a/active.txt", "Active", "Move", false);
        set_file_review_state(&db, "/tmp/root-a/reference.txt", "Reference", "Move", false);
        set_file_review_state(&db, "/tmp/root-a/keep.txt", "Inbox", "Keep", false);
        set_file_review_state(&db, "/tmp/root-a/archive.txt", "Archive", "Archive", false);
        set_file_review_state(&db, "/tmp/root-a/review.txt", "Inbox", "Review", true);
        set_file_review_state(
            &db,
            "/tmp/root-a/delete-candidate.txt",
            "Inbox",
            "DeleteCandidate",
            false,
        );
        set_file_review_state(&db, "/tmp/root-a/duplicate-a.txt", "Inbox", "Move", false);
        set_file_review_state(&db, "/tmp/root-a/duplicate-b.txt", "Inbox", "Move", false);
        set_file_review_state(&db, "/tmp/root-a/passport.pdf", "Sensitive", "Move", true);
        let conn = Connection::open(db.path()).expect("open migrated database");
        conn.execute(
            r#"
            UPDATE files
            SET content_hash = 'same-content'
            WHERE path IN ('/tmp/root-a/duplicate-a.txt', '/tmp/root-a/duplicate-b.txt')
            "#,
            [],
        )
        .expect("set duplicate content hash");
        conn.execute(
            "UPDATE files SET risk_level = 'Sensitive' WHERE path = '/tmp/root-a/passport.pdf'",
            [],
        )
        .expect("set sensitive risk");
        let scope = LibraryScope::Roots {
            roots: vec!["/tmp/root-a".to_string()],
        };

        let active = db
            .get_paged_files_in_scope_with_filter(
                Some(10),
                Some(0),
                None,
                &scope,
                Some(&FileLibraryFilter {
                    library_filter: Some(LibraryFilter::Active),
                }),
            )
            .expect("active page");
        let archive = db
            .get_paged_files_in_scope_with_filter(
                Some(10),
                Some(0),
                None,
                &scope,
                Some(&FileLibraryFilter {
                    library_filter: Some(LibraryFilter::Archive),
                }),
            )
            .expect("archive page");
        let review = db
            .get_paged_files_in_scope_with_filter(
                Some(10),
                Some(0),
                None,
                &scope,
                Some(&FileLibraryFilter {
                    library_filter: Some(LibraryFilter::Review),
                }),
            )
            .expect("review page");
        let duplicate = db
            .get_paged_files_in_scope_with_filter(
                Some(10),
                Some(0),
                None,
                &scope,
                Some(&FileLibraryFilter {
                    library_filter: Some(LibraryFilter::Duplicate),
                }),
            )
            .expect("duplicate page");
        let sensitive = db
            .get_paged_files_in_scope_with_filter(
                Some(10),
                Some(0),
                None,
                &scope,
                Some(&FileLibraryFilter {
                    library_filter: Some(LibraryFilter::Sensitive),
                }),
            )
            .expect("sensitive page");

        assert_eq!(active.total, 3);
        assert!(active.files.iter().any(|file| file.id == "file-active"));
        assert!(active.files.iter().any(|file| file.id == "file-reference"));
        assert!(active.files.iter().any(|file| file.id == "file-keep"));
        assert_eq!(archive.total, 1);
        assert_eq!(archive.files[0].id, "file-archive");
        assert_eq!(review.total, 3);
        assert!(review.files.iter().any(|file| file.id == "file-review"));
        assert!(review
            .files
            .iter()
            .any(|file| file.id == "file-delete-candidate"));
        assert!(review.files.iter().any(|file| file.id == "file-sensitive"));
        assert_eq!(duplicate.total, 2);
        assert!(duplicate
            .files
            .iter()
            .all(|file| file.id == "file-duplicate-a" || file.id == "file-duplicate-b"));
        assert_eq!(sensitive.total, 1);
        assert_eq!(sensitive.files[0].id, "file-sensitive");
    }

    #[test]
    fn get_operation_previews_for_scope_uses_full_scope_not_first_page() {
        let db = Database::open(test_db_path()).expect("open test database");
        for index in 0..60 {
            let name = format!("project-{index:02}.txt");
            let path = format!("/tmp/root-a/{name}");
            insert_test_file_at_path(
                &db,
                &format!("file-{index:02}"),
                &path,
                &name,
                "txt",
                2_048,
                1_900_000_000 + index,
            );
            set_file_operation_suggestion(
                &db,
                &path,
                "Move",
                "/tmp/root-a/ZenCanvas/20_Areas/Projects",
                &name,
                "Normal",
                0.91,
                false,
            );
        }

        let result = db
            .get_operation_previews_for_scope(
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                None,
                Some(100),
                Some(0),
            )
            .expect("scope previews");

        assert_eq!(result.total, 60);
        assert_eq!(result.previews.len(), 60);
        assert!(!result.truncated);
        assert!(!result.has_more);
        assert!(result
            .previews
            .iter()
            .all(|preview| preview.is_executable != Some(false)));
    }

    #[test]
    fn get_operation_previews_for_scope_reports_has_more_for_partial_pages() {
        let db = Database::open(test_db_path()).expect("open test database");
        for index in 0..3 {
            let name = format!("partial-{index}.txt");
            let path = format!("/tmp/root-a/{name}");
            insert_test_file_at_path(
                &db,
                &format!("file-partial-{index}"),
                &path,
                &name,
                "txt",
                2_048,
                1_900_000_000 + index,
            );
            set_file_operation_suggestion(
                &db,
                &path,
                "Move",
                "/tmp/root-a/ZenCanvas/20_Areas/Projects",
                &name,
                "Normal",
                0.91,
                false,
            );
        }

        let first = db
            .get_operation_previews_for_scope(
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                None,
                Some(2),
                Some(0),
            )
            .expect("first page");
        let second = db
            .get_operation_previews_for_scope(
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                None,
                Some(2),
                Some(2),
            )
            .expect("second page");

        assert_eq!(first.total, 3);
        assert_eq!(first.previews.len(), 2);
        assert!(first.truncated);
        assert!(first.has_more);
        assert_eq!(second.previews.len(), 1);
        assert!(!second.truncated);
        assert!(!second.has_more);
    }

    #[test]
    fn get_operation_previews_for_scope_marks_sensitive_files_blocked() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file_at_path(
            &db,
            "file-sensitive",
            "/tmp/root-a/passport.pdf",
            "passport.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        set_file_operation_suggestion(
            &db,
            "/tmp/root-a/passport.pdf",
            "Move",
            "/tmp/root-a/ZenCanvas/20_Areas/Identity",
            "passport.pdf",
            "Sensitive",
            0.95,
            true,
        );

        let result = db
            .get_operation_previews_for_scope(
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                None,
                Some(100),
                Some(0),
            )
            .expect("scope previews");
        let preview = result.previews.first().expect("sensitive preview");

        assert_eq!(result.total, 1);
        assert_eq!(preview.file_id, "file-sensitive");
        assert_eq!(preview.is_executable, Some(false));
        assert_eq!(preview.selected_by_default, Some(false));
        assert!(preview.requires_confirmation);
        assert!(preview
            .blocking_reason
            .as_deref()
            .unwrap_or_default()
            .contains("Sensitive"));
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
    fn get_stats_summary_filters_by_library_scope_roots() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file_at_path(
            &db,
            "file-root-a",
            "/tmp/root-a/a.pdf",
            "a.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        insert_test_file_at_path(
            &db,
            "file-root-b",
            "/tmp/root-b/b.pdf",
            "b.pdf",
            "pdf",
            4_096,
            1_900_000_001,
        );

        let stats = db
            .get_stats_summary_in_scope(&LibraryScope::Roots {
                roots: vec!["/tmp/root-a".to_string()],
            })
            .expect("root a stats");

        assert_eq!(stats.total_files, 1);
        assert_eq!(stats.total_size, 2_048);
        assert_eq!(stats.by_type.get("Document"), Some(&1));
        assert_eq!(stats.by_lifecycle.get("Inbox"), Some(&1));
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
