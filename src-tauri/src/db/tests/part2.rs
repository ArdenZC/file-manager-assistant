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
    fn execute_rules_for_scope_classifies_only_scoped_roots() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file_at_path(
            &db,
            "file-root-a-resume",
            "/tmp/root-a/resume_2026.pdf",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        insert_test_file_at_path(
            &db,
            "file-root-b-invoice",
            "/tmp/root-b/invoice_apple.pdf",
            "invoice_apple.pdf",
            "pdf",
            4_096,
            1_900_000_001,
        );

        let summary = db
            .execute_rules_for_scope(
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                Vec::new(),
            )
            .expect("execute scoped rules");
        let root_a = file_classification(&db, "/tmp/root-a/resume_2026.pdf")
            .expect("root a file");
        let root_b = file_classification(&db, "/tmp/root-b/invoice_apple.pdf")
            .expect("root b file");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(
            root_a,
            ("Career".to_string(), "Reference".to_string(), false)
        );
        assert_eq!(
            root_b,
            ("Unknown".to_string(), "Inbox".to_string(), false)
        );
    }

    #[test]
    fn execute_rules_for_scope_inbox_only_skips_already_classified_files() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file_at_path(
            &db,
            "file-root-a-resume",
            "/tmp/root-a/resume_2026.pdf",
            "resume_2026.pdf",
            "pdf",
            2_048,
            1_900_000_000,
        );
        db.execute_rules_for_scope_with_mode(
            &LibraryScope::Roots {
                roots: vec!["/tmp/root-a".to_string()],
            },
            Vec::new(),
            RuleExecutionMode::InboxOnly,
        )
        .expect("initial scoped rules");
        let summary = db
            .execute_rules_for_scope_with_mode(
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                vec![name_contains_rule(
                    "special-resume-project",
                    "Resume Project",
                    "Project",
                )],
                RuleExecutionMode::InboxOnly,
            )
            .expect("inbox only rules");

        assert_eq!(summary.scanned, 0);
        assert_eq!(summary.updated, 0);
    }

    #[test]
    fn execute_rules_for_scope_all_changed_reclassifies_when_rule_version_changes() {
        let db = Database::open(test_db_path()).expect("open test database");
        insert_test_file_at_path(
            &db,
            "file-root-a-special",
            "/tmp/root-a/special_project.txt",
            "special_project.txt",
            "txt",
            2_048,
            1_900_000_000,
        );
        db.execute_rules_for_scope_with_mode(
            &LibraryScope::Roots {
                roots: vec!["/tmp/root-a".to_string()],
            },
            vec![name_contains_rule(
                "special-project",
                "Special Project",
                "Project",
            )],
            RuleExecutionMode::AllChangedOrRuleChanged,
        )
        .expect("first scoped rules");
        let summary = db
            .execute_rules_for_scope_with_mode(
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                vec![name_contains_rule("special-career", "Special Career", "Career")],
                RuleExecutionMode::AllChangedOrRuleChanged,
            )
            .expect("changed scoped rules");
        let row = file_classification(&db, "/tmp/root-a/special_project.txt")
            .expect("classified file");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 1);
        assert_eq!(row, ("Career".to_string(), "Inbox".to_string(), false));
    }

    #[test]
    fn execute_rules_for_scope_all_changed_skips_unchanged_files_with_same_rules() {
        let db = Database::open(test_db_path()).expect("open test database");
        let rules = vec![name_contains_rule(
            "special-project",
            "Special Project",
            "Project",
        )];
        insert_test_file_at_path(
            &db,
            "file-root-a-special",
            "/tmp/root-a/special_project.txt",
            "special_project.txt",
            "txt",
            2_048,
            1_900_000_000,
        );
        db.execute_rules_for_scope_with_mode(
            &LibraryScope::Roots {
                roots: vec!["/tmp/root-a".to_string()],
            },
            rules.clone(),
            RuleExecutionMode::AllChangedOrRuleChanged,
        )
        .expect("first scoped rules");
        let summary = db
            .execute_rules_for_scope_with_mode(
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
                rules,
                RuleExecutionMode::AllChangedOrRuleChanged,
            )
            .expect("unchanged scoped rules");

        assert_eq!(summary.scanned, 1);
        assert_eq!(summary.updated, 0);
        assert_eq!(summary.skipped, 1);
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
    fn execute_rules_classifies_common_real_world_files_into_actionable_suggestions() {
        let db = Database::open(test_db_path()).expect("open test database");
        let samples = [
            ("file-photo", "photo_001.jpg", "jpg", "Media", "Media/Images"),
            (
                "file-screenshot",
                "截图_桌面.png",
                "png",
                "Media",
                "Screenshots",
            ),
            ("file-video", "vacation.mp4", "mp4", "Media", "Media/Videos"),
            (
                "file-lecture",
                "lecture_notes.pdf",
                "pdf",
                "Study",
                "Study",
            ),
            (
                "file-thesis",
                "毕业论文最终版.docx",
                "docx",
                "Study",
                "Study",
            ),
            ("file-budget", "budget.xlsx", "xlsx", "Finance", "Finance"),
            (
                "file-slides",
                "slides.pptx",
                "pptx",
                "Work",
                "Presentations",
            ),
            (
                "file-archive",
                "archive.zip",
                "zip",
                "Archive",
                "Archives",
            ),
            (
                "file-package",
                "package.json",
                "json",
                "Project",
                "Projects",
            ),
            (
                "file-new-text",
                "新建文本文档.txt",
                "txt",
                "Temporary",
                "90_Temporary",
            ),
        ];

        for (id, name, extension, _, _) in samples {
            insert_test_file(&db, id, name, extension, 2_048, 1_900_000_000);
        }

        db.execute_rules_on_inbox(Vec::new())
            .expect("execute rules");
        let page = db.get_paged_files(Some(50), Some(0), None).expect("page");

        for (_, name, _, expected_purpose, target_fragment) in samples {
            let file = page
                .files
                .iter()
                .find(|file| file.name == name)
                .unwrap_or_else(|| panic!("classified sample {name}"));
            let normalized_target = file.suggested_target_path.replace('\\', "/");

            assert_eq!(file.classification_status, "classified", "{name}");
            assert_eq!(file.purpose, expected_purpose, "{name}");
            assert_ne!(file.suggested_action, "Keep", "{name}");
            assert!(!file.suggested_target_path.is_empty(), "{name}");
            assert!(
                normalized_target.contains(target_fragment),
                "{name} target was {}",
                file.suggested_target_path
            );
        }
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
    fn search_files_uses_like_fallback_for_cjk_short_terms() {
        let db = Database::open(test_db_path()).expect("open test database");
        let samples = [
            ("file-thesis", "毕业论文最终版.docx", "docx"),
            ("file-report", "课程报告.pdf", "pdf"),
            ("file-screenshot", "截图_桌面.png", "png"),
            ("file-photo", "照片001.jpg", "jpg"),
            ("file-java", "Java学习笔记.md", "md"),
        ];
        for (id, name, extension) in samples {
            insert_test_file(&db, id, name, extension, 2_048, 1_900_000_000);
        }

        for (query, expected_name) in [
            ("论文", "毕业论文最终版.docx"),
            ("报告", "课程报告.pdf"),
            ("截图", "截图_桌面.png"),
            ("照片", "照片001.jpg"),
            ("学习", "Java学习笔记.md"),
            ("Java", "Java学习笔记.md"),
        ] {
            let names = db
                .search_files(query, Some(10))
                .expect("search")
                .into_iter()
                .map(|file| file.name)
                .collect::<Vec<_>>();

            assert!(
                names.iter().any(|name| name == expected_name),
                "{query} returned {names:?}"
            );
        }
    }

    #[test]
    fn get_paged_files_uses_like_fallback_for_cjk_short_terms() {
        let db = Database::open(test_db_path()).expect("open test database");
        let samples = [
            ("file-thesis", "毕业论文最终版.docx", "docx"),
            ("file-report", "课程报告.pdf", "pdf"),
            ("file-screenshot", "截图_桌面.png", "png"),
            ("file-photo", "照片001.jpg", "jpg"),
            ("file-java", "Java学习笔记.md", "md"),
        ];
        for (id, name, extension) in samples {
            insert_test_file(&db, id, name, extension, 2_048, 1_900_000_000);
        }

        for (query, expected_name) in [
            ("论文", "毕业论文最终版.docx"),
            ("报告", "课程报告.pdf"),
            ("截图", "截图_桌面.png"),
            ("照片", "照片001.jpg"),
            ("学习", "Java学习笔记.md"),
            ("Java", "Java学习笔记.md"),
        ] {
            let page = db
                .get_paged_files(Some(10), Some(0), Some(query))
                .expect("page search");
            let names = page
                .files
                .into_iter()
                .map(|file| file.name)
                .collect::<Vec<_>>();

            assert!(
                names.iter().any(|name| name == expected_name),
                "{query} returned {names:?}"
            );
        }
    }

    #[test]
    fn search_files_filters_by_library_scope_roots() {
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

        let results = db
            .search_files_in_scope(
                "pdf",
                Some(10),
                &LibraryScope::Roots {
                    roots: vec!["/tmp/root-a".to_string()],
                },
            )
            .expect("search root a");

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].name, "a.pdf");
    }
