use super::super::*;
use crate::file_ops::OperationLogDto;
use rusqlite::{params, Row};
use std::time::{SystemTime, UNIX_EPOCH};

impl Database {
    pub fn get_operation_logs(&self, limit: Option<u32>) -> Result<Vec<OperationLogDto>, DbError> {
        let limit = i64::from(limit.unwrap_or(500).clamp(1, 1000));
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT
                id,
                batch_id,
                operation_type,
                source_path,
                target_path,
                old_name,
                new_name,
                status,
                error_message,
                created_at,
                can_undo,
                path_before,
                path_after,
                name_before,
                name_after,
                can_restore,
                restored_at,
                restore_status,
                restore_error
            FROM operation_logs
            ORDER BY created_at DESC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map(params![limit], operation_log_from_row)?;

        rows.collect::<Result<Vec<_>, _>>().map_err(DbError::from)
    }

    pub fn save_operation_logs(
        &self,
        batch_id: &str,
        logs: &[OperationLogDto],
    ) -> Result<(), DbError> {
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        let created_at = logs
            .first()
            .map(|log| parse_operation_timestamp(&log.created_at))
            .unwrap_or_else(current_timestamp_ms);
        let batch_status = if logs.iter().any(|log| log.status == "failed") {
            "partial_failed"
        } else {
            "success"
        };

        tx.execute(
            r#"
            INSERT INTO operation_batches (id, created_at, status)
            VALUES (?1, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET
                created_at = excluded.created_at,
                status = excluded.status
            "#,
            params![batch_id, created_at, batch_status],
        )?;

        {
            let mut stmt = tx.prepare(
                r#"
                INSERT INTO operation_logs (
                    id,
                    batch_id,
                    operation_type,
                    source_path,
                    target_path,
                    old_name,
                    new_name,
                    status,
                    error_message,
                    created_at,
                    can_undo,
                    path_before,
                    path_after,
                    name_before,
                    name_after,
                    can_restore,
                    restored_at,
                    restore_status,
                    restore_error
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)
                ON CONFLICT(id) DO UPDATE SET
                    batch_id = excluded.batch_id,
                    operation_type = excluded.operation_type,
                    source_path = excluded.source_path,
                    target_path = excluded.target_path,
                    old_name = excluded.old_name,
                    new_name = excluded.new_name,
                    status = excluded.status,
                    error_message = excluded.error_message,
                    created_at = excluded.created_at,
                    can_undo = excluded.can_undo,
                    path_before = excluded.path_before,
                    path_after = excluded.path_after,
                    name_before = excluded.name_before,
                    name_after = excluded.name_after,
                    can_restore = excluded.can_restore,
                    restored_at = excluded.restored_at,
                    restore_status = excluded.restore_status,
                    restore_error = excluded.restore_error
                "#,
            )?;

            for log in logs {
                stmt.execute(params![
                    log.id,
                    log.batch_id,
                    log.operation_type,
                    log.source_path,
                    log.target_path,
                    log.old_name,
                    log.new_name,
                    log.status,
                    log.error_message,
                    parse_operation_timestamp(&log.created_at),
                    bool_to_i64(log.can_undo),
                    log.path_before,
                    log.path_after,
                    log.name_before,
                    log.name_after,
                    bool_to_i64(log.can_restore),
                    log.restored_at
                        .as_deref()
                        .and_then(parse_optional_operation_timestamp),
                    log.restore_status,
                    log.restore_error
                ])?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn update_operation_restore_logs(&self, logs: &[OperationLogDto]) -> Result<(), DbError> {
        if logs.is_empty() {
            return Ok(());
        }

        let mut conn = self.conn()?;
        let tx = conn.transaction()?;
        {
            let mut stmt = tx.prepare(
                r#"
                UPDATE operation_logs
                SET can_restore = ?2,
                    restored_at = ?3,
                    restore_status = ?4,
                    restore_error = ?5,
                    can_undo = ?6
                WHERE id = ?1
                "#,
            )?;

            for log in logs {
                stmt.execute(params![
                    log.id,
                    bool_to_i64(log.can_restore),
                    log.restored_at
                        .as_deref()
                        .and_then(parse_optional_operation_timestamp),
                    log.restore_status,
                    log.restore_error,
                    bool_to_i64(log.can_undo)
                ])?;
            }
        }

        tx.commit()?;
        Ok(())
    }

    pub fn prune_operation_logs(&self, retention_days: i64) -> Result<(), DbError> {
        let retention_days = retention_days.max(0);
        let retention_ms = retention_days.saturating_mul(24 * 60 * 60 * 1000);
        let prune_before = current_timestamp_ms().saturating_sub(retention_ms);
        let mut conn = self.conn()?;
        let tx = conn.transaction()?;

        tx.execute(
            "DELETE FROM operation_logs WHERE created_at < ?1",
            params![prune_before],
        )?;
        tx.execute(
            r#"
            DELETE FROM operation_batches
            WHERE NOT EXISTS (
                SELECT 1
                FROM operation_logs
                WHERE operation_logs.batch_id = operation_batches.id
            )
            "#,
            [],
        )?;

        tx.commit()?;
        Ok(())
    }
}

fn parse_operation_timestamp(value: &str) -> i64 {
    value
        .parse::<i64>()
        .unwrap_or_else(|_| current_timestamp_ms())
}

fn parse_optional_operation_timestamp(value: &str) -> Option<i64> {
    value.parse::<i64>().ok()
}

fn operation_log_from_row(row: &Row<'_>) -> rusqlite::Result<OperationLogDto> {
    let created_at: i64 = row.get(9)?;
    let restored_at: Option<i64> = row.get(16)?;
    Ok(OperationLogDto {
        id: row.get(0)?,
        batch_id: row.get(1)?,
        operation_type: row.get(2)?,
        source_path: row.get(3)?,
        target_path: row.get(4)?,
        old_name: row.get(5)?,
        new_name: row.get(6)?,
        status: row.get(7)?,
        error_message: row.get(8)?,
        created_at: created_at.to_string(),
        can_undo: row.get::<_, i64>(10)? != 0,
        path_before: row.get(11)?,
        path_after: row.get(12)?,
        name_before: row.get(13)?,
        name_after: row.get(14)?,
        can_restore: row.get::<_, i64>(15)? != 0,
        restored_at: restored_at.map(|value| value.to_string()),
        restore_status: row.get(17)?,
        restore_error: row.get(18)?,
    })
}

fn current_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| i64::try_from(duration.as_millis()).unwrap_or(i64::MAX))
        .unwrap_or(0)
}
