use super::super::*;
use super::*;
use crate::file_ops::OperationLogDto;
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection};
use std::{
    collections::HashMap,
    env, fs,
    path::{Path, PathBuf},
    time::Instant,
};
use sysinfo::Disks;

#[derive(Debug, Clone)]
struct SearchMatchSql {
    cte: String,
    params: Vec<SqlValue>,
}

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
    ) -> Result<Vec<FileRecordDto>, DbError> {
        self.search_files_in_scope(query, limit, &LibraryScope::All)
    }

    pub fn search_files_in_scope(
        &self,
        query: &str,
        limit: Option<u32>,
        scope: &LibraryScope,
    ) -> Result<Vec<FileRecordDto>, DbError> {
        let Some(fts_query) = build_fts_query(query) else {
            return Ok(Vec::new());
        };

        let limit = i64::from(limit.unwrap_or(50).clamp(1, 200));
        let now = current_timestamp_iso();
        let conn = self.conn()?;
        let scoped = scoped_files_sql(Some(scope));
        let search = search_match_sql(&fts_query, query);
        let sql = format!(
            r#"
            WITH {},
            {},
            dup_groups AS (
                SELECT size, content_hash
                FROM scoped_files
                WHERE is_dir = 0
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
                bm.rank
            FROM best_matches AS bm
            JOIN scoped_files AS f ON f.rowid = bm.rowid
            LEFT JOIN dup_groups AS dg
              ON dg.size = f.size
             AND dg.content_hash = f.content_hash
            ORDER BY bm.rank ASC, f.mtime DESC, length(f.path) ASC
            LIMIT ?
            "#,
            scoped.cte, search.cte
        );
        let mut params = scoped.params.clone();
        params.extend(search.params);
        params.push(SqlValue::Integer(limit));
        let mut stmt = conn.prepare(&sql)?;

        let rows = stmt.query_map(params_from_iter(params.iter()), indexed_file_from_row)?;

        rows.map(|row| row.map(|file| file_record_from_indexed(file, &now)))
            .collect::<Result<Vec<_>, _>>()
            .map_err(DbError::from)
    }

    pub fn get_paged_files(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
        query: Option<&str>,
    ) -> Result<PagedFilesResult, DbError> {
        self.get_paged_files_in_scope_with_filter(limit, offset, query, &LibraryScope::All, None)
    }

    pub fn get_paged_files_in_scope(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
        query: Option<&str>,
        scope: &LibraryScope,
    ) -> Result<PagedFilesResult, DbError> {
        self.get_paged_files_in_scope_with_filter(limit, offset, query, scope, None)
    }

    pub fn get_paged_files_in_scope_with_filter(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
        query: Option<&str>,
        scope: &LibraryScope,
        filter: Option<&FileLibraryFilter>,
    ) -> Result<PagedFilesResult, DbError> {
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let offset = offset.unwrap_or(0);
        let now = current_timestamp_iso();
        let conn = self.conn()?;
        let scoped =
            scoped_files_sql_with_extra_where(Some(scope), library_filter_pre_dup_clause(filter));
        let post_join_filter = library_filter_post_dup_clause(filter);
        let post_join_where = post_join_where_clause(post_join_filter);

        if let Some((raw_query, fts_query)) =
            query.and_then(|value| build_fts_query(value).map(|fts_query| (value, fts_query)))
        {
            let search = search_match_sql(&fts_query, raw_query);
            let total_sql = if post_join_filter.is_some() {
                format!(
                    r#"
                    WITH {},
                    {},
                    dup_groups AS (
                        SELECT size, content_hash
                        FROM scoped_files
                        WHERE is_dir = 0
                          AND content_hash <> ''
                        GROUP BY size, content_hash
                        HAVING COUNT(*) > 1
                    )
                    SELECT COUNT(*)
                    FROM best_matches AS bm
                    JOIN scoped_files AS f ON f.rowid = bm.rowid
                    LEFT JOIN dup_groups AS dg
                      ON dg.size = f.size
                     AND dg.content_hash = f.content_hash
                    {}
                    "#,
                    scoped.cte,
                    search.cte,
                    post_join_where.as_str()
                )
            } else {
                format!(
                    r#"
                    WITH {},
                    {}
                    SELECT COUNT(*)
                    FROM best_matches
                    "#,
                    scoped.cte, search.cte
                )
            };
            let mut total_params = scoped.params.clone();
            total_params.extend(search.params.clone());
            maybe_print_query_plan(
                &conn,
                "get_paged_files.search.total",
                &total_sql,
                &total_params,
            )?;
            let total =
                conn.query_row(&total_sql, params_from_iter(total_params.iter()), |row| {
                    row.get(0)
                })?;
            let page_sql = format!(
                r#"
                WITH {},
                {},
                dup_groups AS (
                    SELECT size, content_hash
                    FROM scoped_files
                    WHERE is_dir = 0
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
                    bm.rank
                FROM best_matches AS bm
                JOIN scoped_files AS f ON f.rowid = bm.rowid
                LEFT JOIN dup_groups AS dg
                  ON dg.size = f.size
                 AND dg.content_hash = f.content_hash
                {}
                ORDER BY bm.rank ASC, f.mtime DESC, length(f.path) ASC
                LIMIT ? OFFSET ?
                "#,
                scoped.cte,
                search.cte,
                post_join_where.as_str()
            );
            let mut page_params = scoped.params.clone();
            page_params.extend(search.params);
            page_params.push(SqlValue::Integer(i64::from(limit)));
            page_params.push(SqlValue::Integer(i64::from(offset)));
            maybe_print_query_plan(
                &conn,
                "get_paged_files.search.page",
                &page_sql,
                &page_params,
            )?;
            let mut stmt = conn.prepare(&page_sql)?;
            let rows =
                stmt.query_map(params_from_iter(page_params.iter()), indexed_file_from_row)?;
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

        let total_sql = if post_join_filter.is_some() {
            format!(
                r#"
                WITH {},
                dup_groups AS (
                    SELECT size, content_hash
                    FROM scoped_files
                    WHERE is_dir = 0
                      AND content_hash <> ''
                    GROUP BY size, content_hash
                    HAVING COUNT(*) > 1
                )
                SELECT COUNT(*)
                FROM scoped_files AS f
                LEFT JOIN dup_groups AS dg
                  ON dg.size = f.size
                 AND dg.content_hash = f.content_hash
                {}
                "#,
                scoped.cte,
                post_join_where.as_str()
            )
        } else {
            format!("WITH {} SELECT COUNT(*) FROM scoped_files", scoped.cte)
        };
        maybe_print_query_plan(&conn, "get_paged_files.total", &total_sql, &scoped.params)?;
        let total = conn.query_row(&total_sql, params_from_iter(scoped.params.iter()), |row| {
            row.get(0)
        })?;
        let page_sql = format!(
            r#"
            WITH {},
            dup_groups AS (
                SELECT size, content_hash
                FROM scoped_files
                WHERE is_dir = 0
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
            FROM scoped_files AS f
            LEFT JOIN dup_groups AS dg
              ON dg.size = f.size
             AND dg.content_hash = f.content_hash
            {}
            ORDER BY f.mtime DESC, f.name COLLATE NOCASE ASC
            LIMIT ? OFFSET ?
            "#,
            scoped.cte,
            post_join_where.as_str()
        );
        let mut page_params = scoped.params.clone();
        page_params.push(SqlValue::Integer(i64::from(limit)));
        page_params.push(SqlValue::Integer(i64::from(offset)));
        maybe_print_query_plan(&conn, "get_paged_files.page", &page_sql, &page_params)?;
        let mut stmt = conn.prepare(&page_sql)?;
        let rows = stmt.query_map(params_from_iter(page_params.iter()), |row| {
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

    #[cfg(test)]
    pub(crate) fn explain_paged_files_query_plan(
        &self,
        query: Option<&str>,
        scope: &LibraryScope,
        filter: Option<&FileLibraryFilter>,
    ) -> Result<Vec<String>, DbError> {
        let conn = self.conn()?;
        let scoped =
            scoped_files_sql_with_extra_where(Some(scope), library_filter_pre_dup_clause(filter));
        let post_join_filter = library_filter_post_dup_clause(filter);
        let post_join_where = post_join_where_clause(post_join_filter);
        let duplicate_cte = duplicate_filter_cte(post_join_filter);
        let duplicate_join = duplicate_filter_join(post_join_filter);
        if let Some((raw_query, fts_query)) =
            query.and_then(|value| build_fts_query(value).map(|fts_query| (value, fts_query)))
        {
            let search = search_match_sql(&fts_query, raw_query);
            let page_sql = format!(
                r#"
                WITH {},
                {}
                {}
                SELECT f.id
                FROM best_matches AS bm
                JOIN scoped_files AS f ON f.rowid = bm.rowid
                {}
                {}
                ORDER BY bm.rank ASC, f.mtime DESC, length(f.path) ASC
                LIMIT ? OFFSET ?
                "#,
                scoped.cte,
                search.cte,
                duplicate_cte,
                duplicate_join,
                post_join_where.as_str()
            );
            let mut params = scoped.params.clone();
            params.extend(search.params);
            params.push(SqlValue::Integer(50));
            params.push(SqlValue::Integer(0));
            return explain_query_plan(&conn, &page_sql, &params);
        }

        let page_sql = format!(
            r#"
            WITH {}
            SELECT f.id
            FROM scoped_files AS f
            {}
            {}
            ORDER BY f.mtime DESC, f.name COLLATE NOCASE ASC
            LIMIT ? OFFSET ?
            "#,
            if post_join_filter.is_some() {
                format!("{}{}", scoped.cte, duplicate_cte)
            } else {
                scoped.cte
            },
            duplicate_join,
            post_join_where.as_str()
        );
        let mut params = scoped.params.clone();
        params.push(SqlValue::Integer(50));
        params.push(SqlValue::Integer(0));
        explain_query_plan(&conn, &page_sql, &params)
    }

    pub fn get_operation_previews_for_scope(
        &self,
        scope: &LibraryScope,
        filter: Option<&FileLibraryFilter>,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> Result<OperationPreviewScopeResult, DbError> {
        let limit = limit.unwrap_or(1000).clamp(1, 2000);
        let offset = offset.unwrap_or(0);
        let extra_where = operation_preview_filter_clause(filter);
        let scoped = scoped_files_sql_with_extra_where(Some(scope), Some(&extra_where));
        let conn = self.conn()?;

        let total_sql = format!("WITH {} SELECT COUNT(*) FROM scoped_files", scoped.cte);
        let total = conn.query_row(&total_sql, params_from_iter(scoped.params.iter()), |row| {
            row.get::<_, i64>(0)
        })?;
        let page_sql = format!(
            r#"
            WITH {},
            dup_groups AS (
                SELECT size, content_hash
                FROM scoped_files
                WHERE is_dir = 0
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
            FROM scoped_files AS f
            LEFT JOIN dup_groups AS dg
              ON dg.size = f.size
             AND dg.content_hash = f.content_hash
            ORDER BY f.mtime DESC, f.name COLLATE NOCASE ASC
            LIMIT ? OFFSET ?
            "#,
            scoped.cte
        );
        let mut page_params = scoped.params.clone();
        page_params.push(SqlValue::Integer(i64::from(limit)));
        page_params.push(SqlValue::Integer(i64::from(offset)));
        let mut stmt = conn.prepare(&page_sql)?;
        let rows = stmt.query_map(params_from_iter(page_params.iter()), indexed_file_from_row)?;
        let previews = rows
            .map(|row| row.map(operation_preview_from_indexed))
            .filter_map(|row| match row {
                Ok(Some(preview)) => Some(Ok(preview)),
                Ok(None) => None,
                Err(error) => Some(Err(error)),
            })
            .collect::<Result<Vec<_>, _>>()?;

        let has_more = i64::from(offset) + (previews.len() as i64) < total;
        Ok(OperationPreviewScopeResult {
            previews,
            total,
            limit,
            offset,
            truncated: has_more,
            has_more,
        })
    }

    pub fn get_stats_summary(&self) -> Result<StatsSummary, DbError> {
        self.get_stats_summary_in_scope(&LibraryScope::All)
    }

    pub fn get_stats_summary_in_scope(
        &self,
        scope: &LibraryScope,
    ) -> Result<StatsSummary, DbError> {
        let conn = self.conn()?;
        let scoped = scoped_files_sql(Some(scope));
        // 一次事务内完成所有聚合，保证快照一致性
        conn.execute_batch("BEGIN DEFERRED")?;
        let totals_sql = format!(
            r#"
            WITH {},
            dup_groups AS (
                SELECT size, content_hash
                FROM scoped_files
                WHERE is_dir = 0
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
            FROM scoped_files AS f
            LEFT JOIN dup_groups AS dg
              ON dg.size = f.size
             AND dg.content_hash = f.content_hash
            "#,
            scoped.cte
        );
        let (
            total_files,
            total_size,
            large_files,
            sensitive_files,
            needs_confirmation,
            duplicate_files,
            last_mtime,
        ): (i64, i64, i64, i64, i64, i64, Option<i64>) =
            conn.query_row(&totals_sql, params_from_iter(scoped.params.iter()), |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get::<_, Option<i64>>(6)?,
                ))
            })?;
        let mut by_type = HashMap::new();
        let type_sql = format!(
            r#"
            WITH {}
            SELECT file_type, extension, is_dir, COUNT(*)
            FROM scoped_files
            GROUP BY file_type, extension, is_dir
            "#,
            scoped.cte
        );
        let mut stmt = conn.prepare(&type_sql)?;
        let type_rows = stmt.query_map(params_from_iter(scoped.params.iter()), |row| {
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
        let lifecycle_sql = format!(
            r#"
            WITH {}
            SELECT lifecycle, COUNT(*)
            FROM scoped_files
            WHERE is_dir = 0
            GROUP BY lifecycle
            "#,
            scoped.cte
        );
        let mut stmt = conn.prepare(&lifecycle_sql)?;
        let lifecycle_rows = stmt.query_map(params_from_iter(scoped.params.iter()), |row| {
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

fn maybe_print_query_plan(
    conn: &Connection,
    label: &str,
    sql: &str,
    params: &[SqlValue],
) -> Result<(), DbError> {
    if !matches!(
        env::var("ZC_BENCH_EXPLAIN").as_deref(),
        Ok("1" | "true" | "TRUE" | "yes" | "YES")
    ) {
        return Ok(());
    }

    let plan = explain_query_plan(conn, sql, params)?;
    for line in plan {
        eprintln!("[ZC_BENCH_EXPLAIN] {label}: {line}");
    }
    Ok(())
}

fn explain_query_plan(
    conn: &Connection,
    sql: &str,
    params: &[SqlValue],
) -> Result<Vec<String>, DbError> {
    let explain_sql = format!("EXPLAIN QUERY PLAN {sql}");
    let mut stmt = conn.prepare(&explain_sql)?;
    let rows = stmt.query_map(params_from_iter(params.iter()), |row| {
        Ok(format!(
            "id={} parent={} not_used={} detail={}",
            row.get::<_, i64>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?
        ))
    })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
}

fn operation_preview_filter_clause(filter: Option<&FileLibraryFilter>) -> String {
    let action_clause =
        "f.is_dir = 0 AND f.suggested_action IN ('Move', 'Rename', 'MoveAndRename', 'Archive')";
    match library_filter_pre_dup_clause(filter) {
        Some(library_clause) => format!("{action_clause} AND ({library_clause})"),
        None => action_clause.to_string(),
    }
}

fn library_filter_pre_dup_clause(filter: Option<&FileLibraryFilter>) -> Option<&'static str> {
    match filter.and_then(|filter| filter.library_filter.as_ref()) {
        None | Some(LibraryFilter::All) => None,
        Some(LibraryFilter::Active) => {
            Some("f.lifecycle IN ('Active', 'Reference') OR f.suggested_action = 'Keep'")
        }
        Some(LibraryFilter::Archive) => Some("f.lifecycle = 'Archive'"),
        Some(LibraryFilter::Review) => Some(
            "f.requires_confirmation = 1 OR f.suggested_action IN ('Review', 'DeleteCandidate')",
        ),
        Some(LibraryFilter::Duplicate) => None,
        Some(LibraryFilter::Sensitive) => {
            Some("f.risk_level = 'Sensitive' OR f.lifecycle = 'Sensitive'")
        }
    }
}

fn library_filter_post_dup_clause(filter: Option<&FileLibraryFilter>) -> Option<&'static str> {
    match filter.and_then(|filter| filter.library_filter.as_ref()) {
        Some(LibraryFilter::Duplicate) => Some("dg.content_hash IS NOT NULL"),
        _ => None,
    }
}

#[cfg(test)]
fn duplicate_filter_cte(clause: Option<&str>) -> &'static str {
    if clause.is_none() {
        return "";
    }

    r#",
            dup_groups AS (
                SELECT size, content_hash
                FROM scoped_files
                WHERE is_dir = 0
                  AND content_hash <> ''
                GROUP BY size, content_hash
                HAVING COUNT(*) > 1
            )"#
}

#[cfg(test)]
fn duplicate_filter_join(clause: Option<&str>) -> &'static str {
    if clause.is_none() {
        return "";
    }

    r#"
            LEFT JOIN dup_groups AS dg
              ON dg.size = f.size
             AND dg.content_hash = f.content_hash"#
}

fn post_join_where_clause(clause: Option<&str>) -> String {
    clause
        .map(|clause| format!("WHERE ({clause})"))
        .unwrap_or_default()
}

fn operation_preview_from_indexed(row: IndexedFileRow) -> Option<OperationPreviewDto> {
    let source_directory = parent_directory(&row.path);
    let new_name = if row.suggested_name.trim().is_empty() {
        row.name.clone()
    } else {
        row.suggested_name.clone()
    };
    let target_directory = match row.suggested_action.as_str() {
        "Rename" => {
            if row.suggested_target_path.trim().is_empty() {
                source_directory.clone()
            } else {
                row.suggested_target_path.clone()
            }
        }
        "Move" | "MoveAndRename" | "Archive" => row.suggested_target_path.clone(),
        _ => String::new(),
    };
    let target_path = if target_directory.trim().is_empty() {
        row.path.clone()
    } else {
        join_path_text(&target_directory, &new_name)
    };
    if normalize_path_for_compare_text(&row.path) == normalize_path_for_compare_text(&target_path) {
        return None;
    }

    let is_move = !target_directory.trim().is_empty()
        && normalize_path_for_compare_text(&target_directory)
            != normalize_path_for_compare_text(&source_directory);
    let is_rename = new_name != row.name;
    let operation_type = if is_move && is_rename {
        "move_rename"
    } else if is_move {
        "move"
    } else {
        "rename"
    };
    let is_sensitive = row.risk_level == "Sensitive";
    let requires_confirmation = row.requires_confirmation || row.confidence < 0.7 || is_sensitive;
    let is_executable = !is_sensitive;
    let target_parent_exists = Path::new(&target_path)
        .parent()
        .map(|parent| parent.exists())
        .unwrap_or(false);

    Some(OperationPreviewDto {
        id: operation_preview_id(&row.id),
        file_id: row.id,
        operation_type: operation_type.to_string(),
        source_path: row.path,
        target_path,
        old_name: row.name,
        new_name,
        status: "pending".to_string(),
        risk_level: row.risk_level,
        confidence: row.confidence,
        requires_confirmation,
        reason: row.classification_reason,
        selected_by_default: Some(is_executable && !requires_confirmation),
        is_executable: Some(is_executable),
        blocking_reason: is_sensitive
            .then(|| "Sensitive files require manual confirmation.".to_string()),
        editable_new_name: Some(true),
        target_parent_exists: Some(target_parent_exists),
        will_create_parent: Some(!target_parent_exists),
    })
}

fn operation_preview_id(file_id: &str) -> String {
    let digest = blake3::hash(file_id.as_bytes()).to_hex().to_string();
    format!("op-{}", &digest[..16])
}

fn join_path_text(directory: &str, name: &str) -> String {
    let separator = if directory.contains('\\') { '\\' } else { '/' };
    format!(
        "{}{}{}",
        directory.trim_end_matches(['/', '\\']),
        separator,
        name
    )
}

fn normalize_path_for_compare_text(path: &str) -> String {
    normalize_path_text(path)
        .trim_end_matches('/')
        .to_ascii_lowercase()
}

fn search_match_sql(fts_query: &str, raw_query: &str) -> SearchMatchSql {
    let mut cte = String::from(
        r#"
        fts_matches AS (
            SELECT files_fts.rowid, bm25(files_fts, 6.0, 1.5) AS rank
            FROM files_fts
            WHERE files_fts MATCH ?
        ),
        "#,
    );
    let mut params = vec![SqlValue::Text(fts_query.to_string())];

    if should_use_like_fallback(raw_query) {
        let pattern = format!("%{}%", escape_like_pattern(raw_query.trim()));
        cte.push_str(
            r#"
        like_matches AS (
            SELECT f.rowid, 1000000.0 AS rank
            FROM scoped_files AS f
            WHERE f.name LIKE ? ESCAPE '~'
               OR f.path LIKE ? ESCAPE '~'
        ),
        "#,
        );
        params.push(SqlValue::Text(pattern.clone()));
        params.push(SqlValue::Text(pattern));
    } else {
        cte.push_str(
            r#"
        like_matches AS (
            SELECT NULL AS rowid, NULL AS rank
            WHERE 0
        ),
        "#,
        );
    }

    cte.push_str(
        r#"
        search_matches AS (
            SELECT f.rowid, m.rank
            FROM fts_matches AS m
            JOIN scoped_files AS f ON f.rowid = m.rowid
            UNION ALL
            SELECT rowid, rank
            FROM like_matches
        ),
        best_matches AS (
            SELECT rowid, MIN(rank) AS rank
            FROM search_matches
            GROUP BY rowid
        )
        "#,
    );

    SearchMatchSql { cte, params }
}

fn should_use_like_fallback(query: &str) -> bool {
    let trimmed = query.trim();
    !trimmed.is_empty()
        && (trimmed.chars().filter(|ch| !ch.is_whitespace()).count() < 3
            || trimmed.chars().any(is_cjk_character))
}

fn is_cjk_character(ch: char) -> bool {
    matches!(
        ch as u32,
        0x3400..=0x4DBF
            | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF
            | 0x20000..=0x2A6DF
            | 0x2A700..=0x2B73F
            | 0x2B740..=0x2B81F
            | 0x2B820..=0x2CEAF
            | 0x2CEB0..=0x2EBEF
    )
}
