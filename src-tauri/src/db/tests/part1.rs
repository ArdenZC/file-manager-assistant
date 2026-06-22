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
