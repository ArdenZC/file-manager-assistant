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

    fn insert_test_file_at_path(
        db: &Database,
        id: &str,
        path: &str,
        name: &str,
        extension: &str,
        size: i64,
        mtime: i64,
    ) {
        db.insert_file(InsertFileRequest {
            id: id.to_string(),
            path: path.to_string(),
            name: name.to_string(),
            extension: extension.to_string(),
            size,
            mtime,
            ctime: 0,
            is_dir: false,
            state_code: 0,
        })
        .expect("insert scoped file");
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
