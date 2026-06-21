use super::super::*;
use serde_json::Value;

pub(crate) fn built_in_rules() -> Vec<Rule> {
    vec![
        system_rule(
            "system_identity",
            "Sensitive identity documents",
            100.0,
            95.0,
            "OR",
            vec![
                condition("name", "contains", "passport"),
                condition("name", "contains", "visa"),
                condition("name", "contains", "身份证"),
                condition("name", "contains", "护照"),
                condition("path", "contains", "identity"),
            ],
            RuleAction {
                purpose: Some("Identity".to_string()),
                lifecycle: Some("Sensitive".to_string()),
                risk_level: Some("Sensitive".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Personal/Identity".to_string()),
                context: Some("Identity".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_career",
            "Career and resume files",
            90.0,
            84.0,
            "OR",
            vec![
                condition("name", "contains", "resume"),
                condition("name", "contains", "cv"),
                condition("name", "contains", "cover letter"),
                condition("path", "contains", "career"),
            ],
            RuleAction {
                purpose: Some("Career".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Career".to_string()),
                context: Some("Career".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_finance",
            "Finance and receipt files",
            80.0,
            80.0,
            "OR",
            vec![
                condition("name", "contains", "invoice"),
                condition("name", "contains", "receipt"),
                condition("name", "contains", "tax"),
                condition("path", "contains", "bank"),
            ],
            RuleAction {
                purpose: Some("Finance".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Sensitive".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Finance".to_string()),
                context: Some("Finance".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_study",
            "Study material and coursework",
            70.0,
            70.0,
            "OR",
            vec![
                condition("name", "contains", "assignment"),
                condition("name", "contains", "lecture"),
                condition("name", "contains", "paper"),
                condition("name", "contains", "comp"),
            ],
            RuleAction {
                purpose: Some("Study".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Study".to_string()),
                context: Some("Study".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_installer",
            "Installers and setup packages",
            60.0,
            68.0,
            "OR",
            vec![
                condition("file_type", "equals", "Installer"),
                condition("name", "contains", "setup"),
                condition("name", "contains", "installer"),
            ],
            RuleAction {
                purpose: Some("Installer".to_string()),
                lifecycle: Some("Disposable".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("90_Temporary/Installers".to_string()),
                context: Some("Installer".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_project_folder",
            "Project folder boundary",
            55.0,
            86.0,
            "OR",
            vec![condition("extension", "equals", "folder")],
            RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                context: Some("Project Folder".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_inbox_downloads",
            "Downloads and desktop inbox",
            50.0,
            62.0,
            "OR",
            vec![
                condition("directory", "contains", "downloads"),
                condition("directory", "contains", "desktop"),
            ],
            RuleAction {
                purpose: Some("Temporary".to_string()),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("00_Inbox".to_string()),
                context: Some("Inbox".to_string()),
                ..RuleAction::default()
            },
        ),
    ]
}

fn system_rule(
    id: &str,
    name: &str,
    priority: f64,
    weight: f64,
    group_operator: &str,
    conditions: Vec<RuleCondition>,
    action: RuleAction,
) -> Rule {
    Rule {
        id: id.to_string(),
        name: name.to_string(),
        source: "system".to_string(),
        enabled: true,
        priority,
        weight,
        root_operator: "OR".to_string(),
        groups: vec![RuleConditionGroup {
            id: format!("{id}_group"),
            operator: group_operator.to_string(),
            conditions,
        }],
        action,
        created_at: String::new(),
        updated_at: String::new(),
    }
}

fn condition(field: &str, operator: &str, value: &str) -> RuleCondition {
    RuleCondition {
        id: format!("{field}_{operator}_{value}"),
        field: field.to_string(),
        operator: operator.to_string(),
        value: Value::String(value.to_string()),
    }
}
