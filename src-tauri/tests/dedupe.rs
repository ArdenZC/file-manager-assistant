use rusqlite::Connection;
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zen_canvas_tauri::{
    db::{Database, InsertFileRequest},
    dedupe::{
        run_duplicate_detection, run_duplicate_detection_with_hasher, ContentHasher, DedupeError,
        NoopDedupeEventEmitter,
    },
};

#[test]
fn current_schema_retains_content_hash_and_dedupe_index() {
    let db = Database::open(test_db_path()).expect("open test database");
    let conn = Connection::open(db.path()).expect("open migrated database");

    let version: i64 = conn
        .query_row("SELECT user_version FROM pragma_user_version", [], |row| {
            row.get(0)
        })
        .expect("schema version");
    let (content_hash_type, content_hash_notnull): (String, i64) = conn
        .query_row(
            "SELECT type, \"notnull\" FROM pragma_table_info('files') WHERE name = 'content_hash'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .expect("content_hash column");
    let index_sql: String = conn
        .query_row(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_files_dedupe'",
            [],
            |row| row.get(0),
        )
        .expect("dedupe index");

    assert_eq!(version, 11);
    assert_eq!(content_hash_type, "TEXT");
    assert_eq!(content_hash_notnull, 1);
    assert!(index_sql.contains("files(size, content_hash)"));
    assert!(index_sql.contains("WHERE is_dir = 0 AND size > 0"));

    insert_virtual_file(&db, "default-hash.bin", 42, 1);
    let default_content_hash: String = conn
        .query_row(
            "SELECT content_hash FROM files WHERE id = '/test/virtual/default-hash.bin'",
            [],
            |row| row.get(0),
        )
        .expect("default content_hash");
    assert_eq!(default_content_hash, "");
}

#[test]
fn duplicate_detection_marks_only_same_size_same_content_files_as_duplicates() {
    let dir = test_dir("dedupe-content");
    let db = Database::open(dir.join("db.sqlite3")).expect("open test database");
    let duplicate_a = write_indexed_file(&db, &dir, "duplicate-a.txt", b"abc123abc123", 10);
    let duplicate_b = write_indexed_file(&db, &dir, "duplicate-b.txt", b"abc123abc123", 11);
    let same_size_different = write_indexed_file(&db, &dir, "different.txt", b"xyz789xyz789", 12);

    let summary =
        run_duplicate_detection(&db, &NoopDedupeEventEmitter).expect("run duplicate detection");
    let page = db.get_paged_files(Some(10), Some(0), None).expect("page");
    let files = page
        .files
        .iter()
        .map(|file| (file.path.clone(), file))
        .collect::<HashMap<_, _>>();

    let duplicate_a = files
        .get(&duplicate_a.to_string_lossy().to_string())
        .expect("duplicate a");
    let duplicate_b = files
        .get(&duplicate_b.to_string_lossy().to_string())
        .expect("duplicate b");
    let same_size_different = files
        .get(&same_size_different.to_string_lossy().to_string())
        .expect("different content");

    assert_eq!(summary.candidate_files, 3);
    assert_eq!(summary.hashed_files, 3);
    assert_eq!(summary.duplicate_files, 2);
    assert!(duplicate_a.is_duplicate);
    assert!(duplicate_b.is_duplicate);
    assert!(!same_size_different.is_duplicate);
    assert_eq!(duplicate_a.hash, duplicate_b.hash);
    assert_ne!(duplicate_a.hash, same_size_different.hash);
    assert!(duplicate_a
        .hash
        .as_deref()
        .is_some_and(|hash| !hash.is_empty()));

    let stats = db.get_stats_summary().expect("stats");
    assert_eq!(stats.duplicate_files, 2);
}

#[test]
fn unique_file_sizes_do_not_trigger_hash_calculation() {
    let db = Database::open(test_db_path()).expect("open test database");
    for index in 0..128 {
        insert_virtual_file(&db, &format!("unique-{index}.bin"), index + 1, index as i64);
    }
    let mut hasher = CountingHasher::default();

    let summary = run_duplicate_detection_with_hasher(&db, &NoopDedupeEventEmitter, &mut hasher)
        .expect("run duplicate detection");

    assert_eq!(summary.candidate_files, 0);
    assert_eq!(summary.hashed_files, 0);
    assert_eq!(hasher.calls, 0);
}

#[derive(Default)]
struct CountingHasher {
    calls: usize,
}

impl ContentHasher for CountingHasher {
    fn hash_file(&mut self, path: &Path) -> Result<String, DedupeError> {
        self.calls += 1;
        Ok(format!("hash:{}", path.display()))
    }
}

fn write_indexed_file(db: &Database, dir: &Path, name: &str, bytes: &[u8], mtime: i64) -> PathBuf {
    let path = dir.join(name);
    fs::write(&path, bytes).expect("write file");
    db.insert_file(InsertFileRequest {
        id: path.to_string_lossy().into_owned(),
        path: path.to_string_lossy().into_owned(),
        name: name.to_string(),
        extension: "txt".to_string(),
        size: i64::try_from(bytes.len()).expect("test size fits i64"),
        mtime,
        ctime: 0,
        is_dir: false,
        state_code: 0,
    })
    .expect("insert file");
    path
}

fn insert_virtual_file(db: &Database, name: &str, size: usize, mtime: i64) {
    let path = format!("/test/virtual/{name}");
    db.insert_file(InsertFileRequest {
        id: path.clone(),
        path,
        name: name.to_string(),
        extension: "bin".to_string(),
        size: i64::try_from(size).expect("test size fits i64"),
        mtime,
        ctime: 0,
        is_dir: false,
        state_code: 0,
    })
    .expect("insert file");
}

fn test_db_path() -> PathBuf {
    test_dir("dedupe-db").join("zen-canvas-dedupe-test.sqlite3")
}

fn test_dir(prefix: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock")
        .as_nanos();
    let dir = std::env::temp_dir().join(format!("zen-canvas-{prefix}-{nonce}"));
    fs::create_dir_all(&dir).expect("create test dir");
    dir
}
