use super::super::*;
use super::*;
use crate::file_ops::OperationLogDto;
use rusqlite::params;
use std::{collections::HashMap, fs, path::PathBuf, time::Instant};
use sysinfo::Disks;

impl Database {
    pub fn insert_file(&self, file: InsertFileRequest) -> Result<(), DbError> {
        self.insert_files(&[file])
    }

    pub fn insert_files(&self, files: &[InsertFileRequest]) -> Result<(), DbError> {
        if files.is_empty() {
            return Ok(());
        }

        let last_seen_at = current_unix_seconds();
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
            INSERT INTO files (
                id, path, name, extension, size, mtime, ctime, is_dir, state_code,
                file_type, suggested_name, classification_status, is_stale, last_seen_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 0, ?13)
            ON CONFLICT(id) DO UPDATE SET
                path = excluded.path,
                name = excluded.name,
                extension = excluded.extension,
                size = excluded.size,
                mtime = excluded.mtime,
                ctime = excluded.ctime,
                is_dir = excluded.is_dir,
                state_code = excluded.state_code,
                file_type = excluded.file_type,
                suggested_name = CASE
                    WHEN files.suggested_name = '' OR files.suggested_name = files.name
                    THEN excluded.suggested_name
                    ELSE files.suggested_name
                END,
                content_hash = CASE
                    WHEN files.size != excluded.size
                      OR files.mtime != excluded.mtime
                      OR files.is_dir != excluded.is_dir
                    THEN ''
                    ELSE files.content_hash
                END,
                is_stale = 0,
                last_seen_at = excluded.last_seen_at
            "#,
            )?;

            for file in files {
                let file_type = infer_file_type(&file.extension, file.is_dir);
                stmt.execute(params![
                    file.id,
                    file.path,
                    file.name,
                    file.extension,
                    file.size,
                    file.mtime,
                    file.ctime,
                    bool_to_i64(file.is_dir),
                    file.state_code,
                    file_type,
                    file.name,
                    CLASSIFICATION_STATUS_UNCLASSIFIED,
                    last_seen_at
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Compatibility command path for watcher removals: mark matching files stale instead of
    /// deleting rows, so transient file-system events do not destroy index history.
    pub fn remove_files_by_paths(&self, paths: &[String]) -> Result<usize, DbError> {
        if paths.is_empty() {
            return Ok(0);
        }

        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let mut removed = 0;
        {
            let mut stmt = tx.prepare(
                r#"
                UPDATE files
                SET is_stale = 1
                WHERE is_stale = 0
                  AND (
                    path = ?1
                    OR path LIKE ?2 ESCAPE '~'
                    OR path LIKE ?3 ESCAPE '~'
                  )
                "#,
            )?;

            for path in paths
                .iter()
                .map(|path| path.trim())
                .filter(|path| !path.is_empty())
            {
                let path = trim_trailing_path_separators(path);
                if path.is_empty() {
                    continue;
                }

                let normalized_path = normalize_path_text(path);
                for candidate in path_lookup_candidates(path, &normalized_path) {
                    let escaped_path = escape_like_pattern(&candidate);
                    let slash_descendants = format!("{escaped_path}/%");
                    let backslash_descendants = format!("{escaped_path}\\%");
                    removed +=
                        stmt.execute(params![candidate, slash_descendants, backslash_descendants])?;
                }
            }
        }
        tx.commit()?;
        Ok(removed)
    }

    pub fn upsert_files_by_paths(&self, paths: &[String]) -> Result<usize, DbError> {
        upsert_files_by_paths_with_optional_optimize(self, paths)
    }

    pub fn optimize_search_index(&self) -> Result<u128, DbError> {
        let started = Instant::now();
        let conn = self.conn()?;
        conn.execute_batch("PRAGMA optimize;")?;
        Ok(started.elapsed().as_millis())
    }

    pub fn update_file_after_successful_operation(
        &self,
        file_id: &str,
        source_path: &str,
        target_path: &str,
        new_name: &str,
    ) -> Result<bool, DbError> {
        self.update_file_record_after_path_change(
            path_lookup_candidates(file_id, source_path),
            target_path,
            new_name,
        )
    }

    pub fn update_file_after_successful_restore(
        &self,
        log: &OperationLogDto,
    ) -> Result<bool, DbError> {
        if log.restore_status != "restored" {
            return Ok(false);
        }

        self.update_file_record_after_path_change(
            path_lookup_candidates_for_values(&[
                log.path_after.as_str(),
                log.target_path.as_str(),
                log.source_path.as_str(),
            ]),
            &log.path_before,
            &log.name_before,
        )
    }

    fn update_file_record_after_path_change(
        &self,
        lookup_candidates: Vec<String>,
        target_path: &str,
        new_name: &str,
    ) -> Result<bool, DbError> {
        let target = PathBuf::from(target_path);
        let metadata = fs::metadata(&target)?;
        let normalized_target = normalize_path_for_db(&target);
        let name = resolved_file_name(target_path, new_name);
        let extension = extension_from_file_name(&name);
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
        let is_dir = metadata.is_dir();
        let target_candidates = path_lookup_candidates(target_path, &normalized_target);

        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let current_id = find_file_row_id(&tx, &lookup_candidates)?;
        let Some(current_id) = current_id else {
            tx.commit()?;
            return Ok(false);
        };

        for candidate in target_candidates {
            tx.execute(
                r#"
                DELETE FROM files
                WHERE (id = ?1 OR path = ?1)
                  AND id <> ?2
                "#,
                params![candidate, current_id],
            )?;
        }

        let updated = tx.execute(
            r#"
            UPDATE files
            SET id = ?1,
                path = ?1,
                name = ?2,
                extension = ?3,
                size = ?4,
                mtime = ?5,
                is_dir = ?6,
                suggested_action = 'Keep',
                requires_confirmation = 0,
                is_stale = 0,
                last_seen_at = ?7
            WHERE id = ?8
            "#,
            params![
                normalized_target,
                name,
                extension,
                size,
                mtime,
                bool_to_i64(is_dir),
                current_unix_seconds(),
                current_id
            ],
        )?;

        tx.commit()?;
        Ok(updated > 0)
    }

    pub fn search_files(
        &self,
        query: &str,
        limit: Option<u32>,
    ) -> Result<Vec<FileSearchResult>, DbError> {
        let Some(fts_query) = build_fts_query(query) else {
            return Ok(Vec::new());
        };

        let limit = i64::from(limit.unwrap_or(50).clamp(1, 200));
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT
                f.id,
                f.path,
                f.name,
                f.extension,
                f.size,
                f.mtime,
                f.is_dir,
                f.state_code,
                bm25(files_fts, 6.0, 1.5) AS rank
            FROM files_fts
            JOIN files AS f ON f.rowid = files_fts.rowid
            WHERE files_fts MATCH ?1
              AND f.is_stale = 0
            ORDER BY rank ASC, f.mtime DESC, length(f.path) ASC
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(params![fts_query, limit], |row| {
            Ok(FileSearchResult {
                id: row.get(0)?,
                path: row.get(1)?,
                name: row.get(2)?,
                extension: row.get(3)?,
                size: row.get(4)?,
                mtime: row.get(5)?,
                is_dir: row.get::<_, i64>(6)? != 0,
                state_code: row.get(7)?,
                rank: row.get(8)?,
            })
        })?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    pub fn get_paged_files(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
        query: Option<&str>,
    ) -> Result<PagedFilesResult, DbError> {
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let offset = offset.unwrap_or(0);
        let now = current_timestamp_iso();
        let conn = self.conn()?;

        if let Some(fts_query) = query.and_then(build_fts_query) {
            let total = conn.query_row(
                r#"
                SELECT COUNT(*)
                FROM files_fts
                JOIN files AS f ON f.rowid = files_fts.rowid
                WHERE files_fts MATCH ?1
                  AND f.is_stale = 0
                "#,
                params![fts_query],
                |row| row.get(0),
            )?;
            let mut stmt = conn.prepare(
                r#"
                WITH dup_groups AS (
                    SELECT size, content_hash
                    FROM files
                    WHERE is_dir = 0
                      AND is_stale = 0
                      AND content_hash <> ''
                    GROUP BY size, content_hash
                    HAVING COUNT(*) > 1
                )
                SELECT
                    f.id,
                    f.path,
                    f.name,
                    f.extension,
                    f.size,
                    f.mtime,
                    f.ctime,
                    f.is_dir,
                    f.state_code,
                    f.file_type,
                    f.purpose,
                    f.lifecycle,
                    f.context,
                    f.risk_level,
                    f.suggested_action,
                    f.suggested_target_path,
                    f.suggested_name,
                    f.confidence,
                    f.classification_reason,
                    f.classification_status,
                    f.matched_rules,
                    f.requires_confirmation,
                    f.content_hash,
                    (dg.content_hash IS NOT NULL) AS is_duplicate,
                    f.is_stale,
                    f.last_seen_at,
                    f.last_classified_at,
                    f.classified_rule_version,
                    f.last_classified_mtime,
                    f.last_classified_size,
                    bm25(files_fts, 6.0, 1.5) AS rank
                FROM files_fts
                JOIN files AS f ON f.rowid = files_fts.rowid
                LEFT JOIN dup_groups AS dg
                  ON dg.size = f.size
                 AND dg.content_hash = f.content_hash
                WHERE files_fts MATCH ?1
                  AND f.is_stale = 0
                ORDER BY rank ASC, f.mtime DESC, length(f.path) ASC
                LIMIT ?2 OFFSET ?3
                "#,
            )?;
            let rows = stmt.query_map(
                params![fts_query, i64::from(limit), i64::from(offset)],
                indexed_file_from_row,
            )?;
            let files = rows
                .map(|row| row.map(|file| file_record_from_indexed(file, &now)))
                .collect::<Result<Vec<_>, _>>()?;

            return Ok(PagedFilesResult {
                files,
                total,
                limit,
                offset,
            });
        }

        let total = conn.query_row("SELECT COUNT(*) FROM files WHERE is_stale = 0", [], |row| {
            row.get(0)
        })?;
        let mut stmt = conn.prepare(
            r#"
            WITH dup_groups AS (
                SELECT size, content_hash
                FROM files
                WHERE is_dir = 0
                  AND is_stale = 0
                  AND content_hash <> ''
                GROUP BY size, content_hash
                HAVING COUNT(*) > 1
            )
            SELECT f.id, f.path, f.name, f.extension, f.size, f.mtime, f.ctime, f.is_dir, f.state_code,
                   f.file_type, f.purpose, f.lifecycle, f.context, f.risk_level, f.suggested_action,
                   f.suggested_target_path, f.suggested_name, f.confidence, f.classification_reason,
                   f.classification_status, f.matched_rules, f.requires_confirmation, f.content_hash,
                   (dg.content_hash IS NOT NULL) AS is_duplicate,
                   f.is_stale, f.last_seen_at, f.last_classified_at, f.classified_rule_version,
                   f.last_classified_mtime, f.last_classified_size
            FROM files AS f
            LEFT JOIN dup_groups AS dg
              ON dg.size = f.size
             AND dg.content_hash = f.content_hash
            WHERE f.is_stale = 0
            ORDER BY f.mtime DESC, f.name COLLATE NOCASE ASC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;
        let rows = stmt.query_map(params![i64::from(limit), i64::from(offset)], |row| {
            indexed_file_from_row(row)
        })?;
        let files = rows
            .map(|row| row.map(|file| file_record_from_indexed(file, &now)))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(PagedFilesResult {
            files,
            total,
            limit,
            offset,
        })
    }

    pub fn get_stats_summary(&self) -> Result<StatsSummary, DbError> {
        let conn = self.conn()?;
        // 一次事务内完成所有聚合，保证快照一致性
        conn.execute_batch("BEGIN DEFERRED")?;
        let (
            total_files,
            total_size,
            large_files,
            sensitive_files,
            needs_confirmation,
            duplicate_files,
            last_mtime,
        ): (i64, i64, i64, i64, i64, i64, Option<i64>) = conn.query_row(
            r#"
            WITH dup_groups AS (
                SELECT size, content_hash
                FROM files
                WHERE is_dir = 0
                  AND is_stale = 0
                  AND content_hash <> ''
                GROUP BY size, content_hash
                HAVING COUNT(*) > 1
            )
            SELECT
                COUNT(*)        FILTER (WHERE f.is_dir = 0),
                COALESCE(SUM(f.size) FILTER (WHERE f.is_dir = 0), 0),
                COUNT(*)        FILTER (WHERE f.is_dir = 0 AND f.size >= 104857600),
                COUNT(*)        FILTER (WHERE f.is_dir = 0
                                  AND (f.risk_level = 'Sensitive' OR f.lifecycle = 'Sensitive')),
                COUNT(*)        FILTER (WHERE f.is_dir = 0 AND f.requires_confirmation = 1),
                COUNT(*)        FILTER (WHERE f.is_dir = 0 AND dg.content_hash IS NOT NULL),
                MAX(f.mtime)
            FROM files AS f
            LEFT JOIN dup_groups AS dg
              ON dg.size = f.size
             AND dg.content_hash = f.content_hash
            WHERE f.is_stale = 0
            "#,
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            },
        )?;
        let mut by_type = HashMap::new();
        let mut stmt = conn.prepare(
            r#"
            SELECT file_type, extension, is_dir, COUNT(*)
            FROM files
            WHERE is_stale = 0
            GROUP BY file_type, extension, is_dir
            "#,
        )?;
        let type_rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)? != 0,
                row.get::<_, i64>(3)?,
            ))
        })?;
        for row in type_rows {
            let (file_type, extension, is_dir, count) = row?;
            let normalized_type = if file_type.is_empty() || file_type == "Other" {
                infer_file_type(&extension, is_dir).to_string()
            } else {
                file_type
            };
            *by_type.entry(normalized_type).or_insert(0) += count;
        }
        drop(stmt);
        let mut by_lifecycle = HashMap::new();
        let mut stmt = conn.prepare(
            r#"
            SELECT lifecycle, COUNT(*)
            FROM files
            WHERE is_dir = 0
              AND is_stale = 0
            GROUP BY lifecycle
            "#,
        )?;
        let lifecycle_rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        for row in lifecycle_rows {
            let (lifecycle, count) = row?;
            by_lifecycle.insert(lifecycle, count);
        }
        drop(stmt);
        conn.execute_batch("COMMIT")?;
        let disks = Disks::new_with_refreshed_list();
        let (disk_total, disk_free) = disks
            .iter()
            .map(|d| (d.total_space(), d.available_space()))
            .max_by_key(|(total, _)| *total)
            .unwrap_or((0, 0));
        let disk_usage_ratio = if disk_total > 0 {
            1.0 - (disk_free as f64 / disk_total as f64)
        } else {
            0.0
        };

        Ok(StatsSummary {
            total_files,
            total_size,
            disk_total_size: disk_total as i64,
            disk_free_size: disk_free as i64,
            disk_usage_ratio,
            duplicate_files,
            large_files,
            sensitive_files,
            needs_confirmation,
            by_type,
            by_lifecycle,
            last_scanned_at: last_mtime.map(unix_seconds_to_iso),
        })
    }
}
