use super::super::*;
use rusqlite::{params, OptionalExtension, Row};
use std::time::{SystemTime, UNIX_EPOCH};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};

impl Database {
    pub fn get_user_rules(&self) -> Result<Vec<Rule>, DbError> {
        let conn = self.conn()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT
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
            FROM rules
            WHERE source = 'user'
            ORDER BY priority DESC, updated_at DESC, name COLLATE NOCASE ASC
            "#,
        )?;
        let rows = stmt.query_map([], rule_from_row)?;
        let mut rules = Vec::new();
        for row in rows {
            rules.push(rule_from_sql_row(row?)?);
        }

        Ok(rules)
    }

    pub fn save_user_rule(&self, rule: Rule) -> Result<Rule, DbError> {
        let mut rule = rule;
        rule.source = "user".to_string();
        let now = current_timestamp_iso();
        if rule.created_at.trim().is_empty() {
            rule.created_at =
                existing_rule_created_at(self, &rule.id)?.unwrap_or_else(|| now.clone());
        }
        if rule.updated_at.trim().is_empty() {
            rule.updated_at = now;
        }
        let groups_json = serde_json::to_string(&rule.groups)?;
        let action_json = serde_json::to_string(&rule.action)?;
        let rule_id = rule.id.clone();
        let conn = self.conn()?;
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
            VALUES (?1, ?2, 'user', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                source = 'user',
                enabled = excluded.enabled,
                priority = excluded.priority,
                weight = excluded.weight,
                root_operator = excluded.root_operator,
                groups_json = excluded.groups_json,
                action_json = excluded.action_json,
                updated_at = excluded.updated_at
            "#,
            params![
                rule.id,
                rule.name,
                bool_to_i64(rule.enabled),
                rule.priority,
                rule.weight,
                rule.root_operator,
                groups_json,
                action_json,
                rule.created_at,
                rule.updated_at
            ],
        )?;

        get_user_rule_by_id(self, &rule_id)
    }

    pub fn delete_user_rule(&self, id: &str) -> Result<bool, DbError> {
        let id = id.trim();
        if id.is_empty() {
            return Ok(false);
        }

        let conn = self.conn()?;
        let deleted = conn.execute(
            "DELETE FROM rules WHERE id = ?1 AND source = 'user'",
            params![id],
        )?;
        Ok(deleted > 0)
    }
}

fn rule_from_row(row: &Row<'_>) -> rusqlite::Result<RuleSqlRow> {
    Ok(RuleSqlRow {
        id: row.get(0)?,
        name: row.get(1)?,
        source: row.get(2)?,
        enabled: row.get::<_, i64>(3)? != 0,
        priority: row.get(4)?,
        weight: row.get(5)?,
        root_operator: row.get(6)?,
        groups_json: row.get(7)?,
        action_json: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn rule_from_sql_row(row: RuleSqlRow) -> Result<Rule, DbError> {
    Ok(Rule {
        id: row.id,
        name: row.name,
        source: row.source,
        enabled: row.enabled,
        priority: row.priority,
        weight: row.weight,
        root_operator: row.root_operator,
        groups: serde_json::from_str::<Vec<RuleConditionGroup>>(&row.groups_json)?,
        action: serde_json::from_str::<RuleAction>(&row.action_json)?,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

fn existing_rule_created_at(db: &Database, id: &str) -> Result<Option<String>, DbError> {
    let conn = db.conn()?;
    conn.query_row(
        "SELECT created_at FROM rules WHERE id = ?1",
        params![id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .map_err(DbError::from)
}

fn get_user_rule_by_id(db: &Database, id: &str) -> Result<Rule, DbError> {
    let conn = db.conn()?;
    let row = conn.query_row(
        r#"
        SELECT
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
        FROM rules
        WHERE id = ?1
          AND source = 'user'
        "#,
        params![id],
        rule_from_row,
    )?;
    rule_from_sql_row(row)
}

pub(super) fn current_timestamp_iso() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    OffsetDateTime::from_unix_timestamp(seconds)
        .ok()
        .and_then(|time| time.format(&Rfc3339).ok())
        .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string())
}
