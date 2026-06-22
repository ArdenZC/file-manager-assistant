use super::super::*;
use super::{
    builtin_rules::{built_in_rules, classify_builtin, days_since_unix},
    naming::{build_suggested_name, build_target_path},
};
use rusqlite::{params, params_from_iter, Connection};
use serde_json::Value;
use sha2::{Digest, Sha256};

impl Database {
    pub fn execute_rules_on_inbox(
        &self,
        rules: Vec<Rule>,
    ) -> Result<RuleExecutionSummary, DbError> {
        let settings = crate::settings::get_app_settings(self)?;
        self.execute_rules_on_inbox_with_folder_naming_language(
            rules,
            &settings.folder_naming_language,
        )
    }

    pub fn execute_rules_for_scope(
        &self,
        scope: &LibraryScope,
        rules: Vec<Rule>,
    ) -> Result<RuleExecutionSummary, DbError> {
        let settings = crate::settings::get_app_settings(self)?;
        self.execute_rules_for_scope_with_folder_naming_language(
            scope,
            rules,
            &settings.folder_naming_language,
        )
    }

    fn execute_rules_for_scope_with_folder_naming_language(
        &self,
        scope: &LibraryScope,
        rules: Vec<Rule>,
        folder_naming_language: &str,
    ) -> Result<RuleExecutionSummary, DbError> {
        let all_rules = active_rules(rules);
        let rule_version = classification_version_for_rules(&all_rules, folder_naming_language)?;
        let scoped = scoped_files_sql(Some(scope));
        let sql = format!(
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
                WHERE f.lifecycle = 'Inbox'
                ORDER BY f.mtime DESC, f.name COLLATE NOCASE ASC
                "#,
            scoped.cte
        );
        let read_conn = self.conn()?;
        let mut write_conn = self.conn()?;
        let mut stmt = read_conn.prepare(&sql)?;
        let mut rows = stmt.query(params_from_iter(scoped.params.iter()))?;

        let mut scanned = 0_i64;
        let mut updated = 0_i64;
        let mut skipped = 0_i64;
        let mut needs_confirmation = 0_i64;
        let mut batch = Vec::with_capacity(CLASSIFY_BATCH_SIZE);

        while let Some(row) = rows.next()? {
            let row = indexed_file_from_row(row)?;
            scanned += 1;
            if !should_classify_file(&row, &rule_version) {
                skipped += 1;
                continue;
            }

            batch.push(row);

            if batch.len() == CLASSIFY_BATCH_SIZE {
                let batch_summary = execute_classification_batch(
                    &mut write_conn,
                    &batch,
                    &all_rules,
                    &rule_version,
                    folder_naming_language,
                )?;
                updated += batch_summary.updated;
                needs_confirmation += batch_summary.needs_confirmation;
                batch.clear();
            }
        }

        if !batch.is_empty() {
            let batch_summary = execute_classification_batch(
                &mut write_conn,
                &batch,
                &all_rules,
                &rule_version,
                folder_naming_language,
            )?;
            updated += batch_summary.updated;
            needs_confirmation += batch_summary.needs_confirmation;
        }

        Ok(RuleExecutionSummary {
            scanned,
            updated,
            skipped,
            needs_confirmation,
        })
    }

    fn execute_rules_on_inbox_with_folder_naming_language(
        &self,
        rules: Vec<Rule>,
        folder_naming_language: &str,
    ) -> Result<RuleExecutionSummary, DbError> {
        let all_rules = active_rules(rules);
        let rule_version = classification_version_for_rules(&all_rules, folder_naming_language)?;
        let read_conn = self.conn()?;
        let mut write_conn = self.conn()?;
        let mut stmt = read_conn.prepare(
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
                WHERE f.lifecycle = 'Inbox'
                  AND f.is_stale = 0
                ORDER BY f.mtime DESC, f.name COLLATE NOCASE ASC
                "#,
        )?;
        let mut rows = stmt.query([])?;

        let mut scanned = 0_i64;
        let mut updated = 0_i64;
        let mut skipped = 0_i64;
        let mut needs_confirmation = 0_i64;
        let mut batch = Vec::with_capacity(CLASSIFY_BATCH_SIZE);

        while let Some(row) = rows.next()? {
            let row = indexed_file_from_row(row)?;
            scanned += 1;
            if !should_classify_file(&row, &rule_version) {
                skipped += 1;
                continue;
            }

            batch.push(row);

            if batch.len() == CLASSIFY_BATCH_SIZE {
                let batch_summary = execute_classification_batch(
                    &mut write_conn,
                    &batch,
                    &all_rules,
                    &rule_version,
                    folder_naming_language,
                )?;
                updated += batch_summary.updated;
                needs_confirmation += batch_summary.needs_confirmation;
                batch.clear();
            }
        }

        if !batch.is_empty() {
            let batch_summary = execute_classification_batch(
                &mut write_conn,
                &batch,
                &all_rules,
                &rule_version,
                folder_naming_language,
            )?;
            updated += batch_summary.updated;
            needs_confirmation += batch_summary.needs_confirmation;
        }

        Ok(RuleExecutionSummary {
            scanned,
            updated,
            skipped,
            needs_confirmation,
        })
    }

    pub fn execute_rules_for_paths(
        &self,
        paths: &[String],
        rules: Vec<Rule>,
    ) -> Result<RuleExecutionSummary, DbError> {
        let settings = crate::settings::get_app_settings(self)?;
        self.execute_rules_for_paths_with_folder_naming_language(
            paths,
            rules,
            &settings.folder_naming_language,
        )
    }

    fn execute_rules_for_paths_with_folder_naming_language(
        &self,
        paths: &[String],
        rules: Vec<Rule>,
        folder_naming_language: &str,
    ) -> Result<RuleExecutionSummary, DbError> {
        let target_paths = classification_path_candidates(paths, 500);
        if target_paths.is_empty() {
            return Ok(RuleExecutionSummary {
                scanned: 0,
                updated: 0,
                skipped: 0,
                needs_confirmation: 0,
            });
        }

        let all_rules = active_rules(rules);
        let rule_version = classification_version_for_rules(&all_rules, folder_naming_language)?;
        let placeholders = std::iter::repeat("?")
            .take(target_paths.len())
            .collect::<Vec<_>>()
            .join(", ");
        let sql = format!(
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
            WHERE f.lifecycle = 'Inbox'
              AND f.is_stale = 0
              AND f.path IN ({placeholders})
            ORDER BY f.mtime DESC, f.name COLLATE NOCASE ASC
            "#
        );
        let read_conn = self.conn()?;
        let mut write_conn = self.conn()?;
        let mut stmt = read_conn.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(target_paths.iter()), indexed_file_from_row)?;

        let mut scanned = 0_i64;
        let mut updated = 0_i64;
        let mut skipped = 0_i64;
        let mut needs_confirmation = 0_i64;
        let mut batch = Vec::with_capacity(CLASSIFY_BATCH_SIZE);

        for row in rows {
            let row = row?;
            scanned += 1;
            if !should_classify_file(&row, &rule_version) {
                skipped += 1;
                continue;
            }

            batch.push(row);

            if batch.len() == CLASSIFY_BATCH_SIZE {
                let batch_summary = execute_classification_batch(
                    &mut write_conn,
                    &batch,
                    &all_rules,
                    &rule_version,
                    folder_naming_language,
                )?;
                updated += batch_summary.updated;
                needs_confirmation += batch_summary.needs_confirmation;
                batch.clear();
            }
        }

        if !batch.is_empty() {
            let batch_summary = execute_classification_batch(
                &mut write_conn,
                &batch,
                &all_rules,
                &rule_version,
                folder_naming_language,
            )?;
            updated += batch_summary.updated;
            needs_confirmation += batch_summary.needs_confirmation;
        }

        Ok(RuleExecutionSummary {
            scanned,
            updated,
            skipped,
            needs_confirmation,
        })
    }
}

fn active_rules(rules: Vec<Rule>) -> Vec<Rule> {
    built_in_rules()
        .into_iter()
        .chain(rules.into_iter().filter(|rule| rule.enabled))
        .collect()
}

pub(crate) fn rule_version_for_rules(rules: &[Rule]) -> Result<String, DbError> {
    let mut stable_rules = rules.to_vec();
    stable_rules.sort_by(|left, right| {
        left.priority
            .partial_cmp(&right.priority)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| left.id.cmp(&right.id))
            .then_with(|| left.name.cmp(&right.name))
            .then_with(|| left.source.cmp(&right.source))
    });
    let payload = serde_json::to_string(&stable_rules)?;
    let digest = Sha256::digest(payload.as_bytes());
    Ok(digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

fn classification_version_for_rules(
    rules: &[Rule],
    folder_naming_language: &str,
) -> Result<String, DbError> {
    let rules_version = rule_version_for_rules(rules)?;
    let payload = format!("{rules_version}:folder_naming_language={folder_naming_language}");
    let digest = Sha256::digest(payload.as_bytes());
    Ok(digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>())
}

fn should_classify_file(row: &IndexedFileRow, rule_version: &str) -> bool {
    row.last_classified_at == 0
        || row.classified_rule_version != rule_version
        || row.last_classified_mtime != row.mtime
        || row.last_classified_size != row.size
}

fn classification_path_candidates(paths: &[String], limit: usize) -> Vec<String> {
    let mut candidates = Vec::new();
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
            push_unique(&mut candidates, candidate);
            if candidates.len() >= limit {
                return candidates;
            }
        }
    }
    candidates
}

fn execute_classification_batch(
    conn: &mut Connection,
    batch: &[IndexedFileRow],
    all_rules: &[Rule],
    rule_version: &str,
    folder_naming_language: &str,
) -> Result<RuleExecutionSummary, DbError> {
    let mut updated = 0_i64;
    let mut needs_confirmation = 0_i64;
    let classified_at = current_unix_seconds();
    let tx = conn.transaction()?;
    {
        let mut stmt = tx.prepare(
            r#"
                UPDATE files
                SET file_type = ?2,
                    purpose = ?3,
                    lifecycle = ?4,
                    context = ?5,
                    risk_level = ?6,
                    suggested_action = ?7,
                    suggested_target_path = ?8,
                    suggested_name = ?9,
                    confidence = ?10,
                    classification_reason = ?11,
                    classification_status = ?12,
                    matched_rules = ?13,
                    requires_confirmation = ?14,
                    last_classified_at = ?15,
                    classified_rule_version = ?16,
                    last_classified_mtime = ?17,
                    last_classified_size = ?18
                WHERE id = ?1
                "#,
        )?;

        for row in batch {
            let classification = classify_indexed_file(row, all_rules, folder_naming_language)?;
            if classification.requires_confirmation {
                needs_confirmation += 1;
            }
            stmt.execute(params![
                row.id,
                classification.file_type,
                classification.purpose,
                classification.lifecycle,
                classification.context,
                classification.risk_level,
                classification.suggested_action,
                classification.suggested_target_path,
                classification.suggested_name,
                classification.confidence,
                classification.classification_reason,
                classification.classification_status,
                classification.matched_rules,
                bool_to_i64(classification.requires_confirmation),
                classified_at,
                rule_version,
                row.mtime,
                row.size
            ])?;
            updated += 1;
        }
    }
    tx.commit()?;

    Ok(RuleExecutionSummary {
        scanned: batch.len() as i64,
        updated,
        skipped: 0,
        needs_confirmation,
    })
}

fn classify_indexed_file(
    row: &IndexedFileRow,
    all_rules: &[Rule],
    folder_naming_language: &str,
) -> Result<ClassificationUpdate, DbError> {
    let file_type = normalized_file_type(row);
    let builtin = classify_builtin(row, &file_type);
    let mut candidates = all_rules
        .iter()
        .filter_map(|rule| {
            let matches = evaluate_rule(rule, row, &file_type);
            matches.then(|| RuleCandidate {
                score: rule.weight + rule.priority * 0.1,
                rule: rule.clone(),
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .score
            .partial_cmp(&left.score)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                right
                    .rule
                    .priority
                    .partial_cmp(&left.rule.priority)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });

    let top = candidates.first();
    let runner_up = candidates.get(1);
    let has_conflict = top
        .zip(runner_up)
        .map(|(top, runner_up)| top.score - runner_up.score <= 10.0)
        .unwrap_or(false);
    let action = top
        .map(|candidate| merge_action(&builtin.action, &candidate.rule.action))
        .unwrap_or_else(|| builtin.action.clone());
    let matched_rule_names = candidates
        .iter()
        .map(|candidate| candidate.rule.name.clone())
        .collect::<Vec<_>>();
    let confidence = top
        .map(|candidate| (candidate.score / 100.0).clamp(0.35, 0.98))
        .unwrap_or(builtin.confidence);
    let risk_level = action
        .risk_level
        .clone()
        .unwrap_or_else(|| default_if_empty(&row.risk_level, "Unknown"));
    let suggested_action = safe_action(
        &action
            .suggested_action
            .clone()
            .unwrap_or_else(|| default_if_empty(&row.suggested_action, "Keep")),
        &risk_level,
    );
    let suggested_target_path = build_target_path(
        row,
        &file_type,
        action.target_template.as_deref(),
        folder_naming_language,
    );
    let suggested_name = build_suggested_name(row, action.rename_template.as_deref());
    let requires_confirmation = risk_level == "Sensitive"
        || has_conflict
        || confidence < 0.65
        || suggested_action == "Review"
        || suggested_action == "DeleteCandidate";

    Ok(ClassificationUpdate {
        file_type,
        purpose: action
            .purpose
            .clone()
            .unwrap_or_else(|| default_if_empty(&row.purpose, "Unknown")),
        lifecycle: action
            .lifecycle
            .clone()
            .unwrap_or_else(|| default_if_empty(&row.lifecycle, "Inbox")),
        context: action
            .context
            .clone()
            .unwrap_or_else(|| row.context.clone()),
        risk_level: risk_level.clone(),
        suggested_action,
        suggested_target_path,
        suggested_name,
        confidence,
        classification_reason: build_classification_reason(
            &matched_rule_names,
            has_conflict,
            &risk_level,
        ),
        classification_status: CLASSIFICATION_STATUS_CLASSIFIED.to_string(),
        matched_rules: serde_json::to_string(&matched_rule_names)?,
        requires_confirmation,
    })
}

fn evaluate_rule(rule: &Rule, row: &IndexedFileRow, file_type: &str) -> bool {
    if !rule.enabled || rule.groups.is_empty() {
        return false;
    }
    let results = rule
        .groups
        .iter()
        .map(|group| evaluate_group(group, row, file_type))
        .collect::<Vec<_>>();
    if rule.root_operator.eq_ignore_ascii_case("AND") {
        results.iter().all(|value| *value)
    } else {
        results.iter().any(|value| *value)
    }
}

fn evaluate_group(group: &RuleConditionGroup, row: &IndexedFileRow, file_type: &str) -> bool {
    if group.conditions.is_empty() {
        return false;
    }
    let results = group
        .conditions
        .iter()
        .map(|condition| evaluate_condition(condition, row, file_type))
        .collect::<Vec<_>>();
    if group.operator.eq_ignore_ascii_case("OR") {
        results.iter().any(|value| *value)
    } else {
        results.iter().all(|value| *value)
    }
}

fn evaluate_condition(condition: &RuleCondition, row: &IndexedFileRow, file_type: &str) -> bool {
    let raw = condition_value(&condition.field, row, file_type).to_lowercase();
    let expected = json_value_to_string(&condition.value).to_lowercase();
    match condition.operator.as_str() {
        "contains" => raw.contains(&expected),
        "equals" | "is" => raw == expected,
        "startsWith" => raw.starts_with(&expected),
        "endsWith" => raw.ends_with(&expected),
        "greaterThan" => raw.parse::<f64>().unwrap_or(0.0) > json_value_to_f64(&condition.value),
        "lessThan" => raw.parse::<f64>().unwrap_or(0.0) < json_value_to_f64(&condition.value),
        "olderThanDays" => days_since_unix(row.mtime) > json_value_to_i64(&condition.value),
        "newerThanDays" => days_since_unix(row.mtime) < json_value_to_i64(&condition.value),
        _ => false,
    }
}

fn condition_value(field: &str, row: &IndexedFileRow, file_type: &str) -> String {
    match field {
        "name" => row.name.clone(),
        "extension" => {
            if row.is_dir {
                "folder".to_string()
            } else {
                row.extension.clone()
            }
        }
        "file_type" => file_type.to_string(),
        "path" => row.path.clone(),
        "directory" => parent_directory(&row.path),
        "size" => row.size.to_string(),
        "modified_at" => unix_seconds_to_iso(row.mtime),
        "is_duplicate" => row.is_duplicate.to_string(),
        "risk_level" => row.risk_level.clone(),
        _ => String::new(),
    }
}

fn merge_action(base: &RuleAction, override_action: &RuleAction) -> RuleAction {
    RuleAction {
        purpose: override_action
            .purpose
            .clone()
            .or_else(|| base.purpose.clone()),
        lifecycle: override_action
            .lifecycle
            .clone()
            .or_else(|| base.lifecycle.clone()),
        context: override_action
            .context
            .clone()
            .or_else(|| base.context.clone()),
        risk_level: override_action
            .risk_level
            .clone()
            .or_else(|| base.risk_level.clone()),
        suggested_action: override_action
            .suggested_action
            .clone()
            .or_else(|| base.suggested_action.clone()),
        target_template: override_action
            .target_template
            .clone()
            .or_else(|| base.target_template.clone()),
        rename_template: override_action
            .rename_template
            .clone()
            .or_else(|| base.rename_template.clone()),
    }
}

fn build_classification_reason(
    matched_rules: &[String],
    has_conflict: bool,
    risk_level: &str,
) -> String {
    let mut parts = if matched_rules.is_empty() {
        vec!["No strong rule matched".to_string()]
    } else {
        vec![format!(
            "Matched {}",
            matched_rules
                .iter()
                .take(3)
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )]
    };
    if has_conflict {
        parts.push("similar rule scores require review".to_string());
    }
    if risk_level == "Sensitive" {
        parts.push("sensitive files require manual confirmation".to_string());
    }
    parts.join("; ")
}

fn safe_action(action: &str, risk_level: &str) -> String {
    if (risk_level == "Sensitive" && action != "Keep") || action == "DeleteCandidate" {
        "Review".to_string()
    } else {
        action.to_string()
    }
}

pub(crate) fn normalized_file_type(row: &IndexedFileRow) -> String {
    if row.file_type.is_empty() || row.file_type == "Other" {
        infer_file_type(&row.extension, row.is_dir).to_string()
    } else {
        row.file_type.clone()
    }
}

fn default_if_empty(value: &str, fallback: &str) -> String {
    if value.is_empty() {
        fallback.to_string()
    } else {
        value.to_string()
    }
}

fn json_value_to_string(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn json_value_to_f64(value: &Value) -> f64 {
    match value {
        Value::Number(value) => value.as_f64().unwrap_or(0.0),
        Value::String(value) => value.parse().unwrap_or(0.0),
        Value::Bool(true) => 1.0,
        Value::Bool(false) => 0.0,
        _ => 0.0,
    }
}

fn json_value_to_i64(value: &Value) -> i64 {
    json_value_to_f64(value) as i64
}
