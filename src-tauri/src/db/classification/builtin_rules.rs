use super::super::*;
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

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
                condition("name", "contains", "budget"),
                condition("name", "contains", "statement"),
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
            "system_code_project_manifest",
            "Code project manifests",
            58.0,
            80.0,
            "OR",
            vec![
                condition("name", "contains", "package.json"),
                condition("name", "contains", "cargo.toml"),
                condition("name", "contains", "pom.xml"),
                condition("name", "contains", "build.gradle"),
                condition("name", "contains", "requirements.txt"),
                condition("name", "contains", "pyproject.toml"),
                condition("name", "contains", "go.mod"),
            ],
            RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                context: Some("Code Project".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_screenshots",
            "Screenshots and screen captures",
            57.0,
            78.0,
            "OR",
            vec![
                condition("name", "contains", "screenshot"),
                condition("name", "contains", "screen shot"),
                condition("name", "contains", "截图"),
                condition("name", "contains", "屏幕截图"),
                condition("name", "contains", "微信图片"),
                condition("name", "contains", "微信截图"),
            ],
            RuleAction {
                purpose: Some("Media".to_string()),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Rename".to_string()),
                target_template: Some("00_Inbox/Screenshots".to_string()),
                rename_template: Some("{basename}_{date}".to_string()),
                context: Some("Screenshot".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_temporary_names",
            "Temporary and newly-created files",
            56.0,
            72.0,
            "OR",
            vec![
                condition("name", "contains", "temp"),
                condition("name", "contains", "tmp"),
                condition("name", "contains", "copy"),
                condition("name", "contains", "download"),
                condition("name", "contains", "副本"),
                condition("name", "contains", "未命名"),
                condition("name", "contains", "新建"),
            ],
            RuleAction {
                purpose: Some("Temporary".to_string()),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("90_Temporary".to_string()),
                context: Some("Temporary".to_string()),
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
                condition("name", "contains", "论文"),
                condition("name", "contains", "毕业"),
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
            "system_images",
            "Images and photos",
            45.0,
            72.0,
            "OR",
            vec![condition("file_type", "equals", "Image")],
            RuleAction {
                purpose: Some("Media".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Media/Images".to_string()),
                context: Some("Image".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_videos",
            "Videos",
            44.0,
            72.0,
            "OR",
            vec![condition("file_type", "equals", "Video")],
            RuleAction {
                purpose: Some("Media".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Media/Videos".to_string()),
                context: Some("Video".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_audio",
            "Audio",
            43.0,
            70.0,
            "OR",
            vec![condition("file_type", "equals", "Audio")],
            RuleAction {
                purpose: Some("Media".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Media/Audio".to_string()),
                context: Some("Audio".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_spreadsheets",
            "Spreadsheets",
            42.0,
            68.0,
            "OR",
            vec![condition("file_type", "equals", "Spreadsheet")],
            RuleAction {
                purpose: Some("Work".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Documents/Spreadsheets".to_string()),
                context: Some("Spreadsheet".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_presentations",
            "Presentations",
            41.0,
            68.0,
            "OR",
            vec![condition("file_type", "equals", "Presentation")],
            RuleAction {
                purpose: Some("Work".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Documents/Presentations".to_string()),
                context: Some("Presentation".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_archive_packages",
            "Compressed archives",
            40.0,
            66.0,
            "OR",
            vec![condition("file_type", "equals", "ArchivePackage")],
            RuleAction {
                purpose: Some("Archive".to_string()),
                lifecycle: Some("Disposable".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("90_Temporary/Archives".to_string()),
                context: Some("Archive Package".to_string()),
                ..RuleAction::default()
            },
        ),
        system_rule(
            "system_documents",
            "General documents",
            30.0,
            60.0,
            "OR",
            vec![condition("file_type", "equals", "Document")],
            RuleAction {
                purpose: Some("Work".to_string()),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("00_Inbox/Documents".to_string()),
                context: Some("Document".to_string()),
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

pub(super) fn classify_builtin(row: &IndexedFileRow, file_type: &str) -> BuiltinClassification {
    let haystack = format!("{} {}", row.name, row.path).to_lowercase();
    let name = row.name.to_lowercase();
    let age_days = days_since_unix(row.mtime);

    if row.is_dir {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                context: Some("Project Folder".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.86,
        };
    }

    if any_contains(
        &haystack,
        &[
            "passport",
            "visa",
            "id",
            "identity",
            "private",
            "身份证",
            "护照",
            "银行卡",
        ],
    ) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Identity".to_string()),
                lifecycle: Some("Sensitive".to_string()),
                risk_level: Some("Sensitive".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Personal/Identity".to_string()),
                context: Some("Identity".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.92,
        };
    }

    if any_contains(
        &haystack,
        &["resume", "cv", "cover letter", "portfolio", "interview"],
    ) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Career".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Career".to_string()),
                context: Some("Career".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.84,
        };
    }

    if any_contains(
        &haystack,
        &[
            "invoice",
            "receipt",
            "bill",
            "tax",
            "payment",
            "bank",
            "paypal",
            "budget",
            "statement",
        ],
    ) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Finance".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Sensitive".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Finance".to_string()),
                context: Some("Finance".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.78,
        };
    }

    if is_project_manifest(&name) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                context: Some("Code Project".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.86,
        };
    }

    if is_screenshot_name(&haystack) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some(
                    if file_type == "Image" {
                        "Media"
                    } else {
                        "Temporary"
                    }
                    .to_string(),
                ),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Rename".to_string()),
                target_template: Some("00_Inbox/Screenshots".to_string()),
                rename_template: Some("{basename}_{date}".to_string()),
                context: Some("Screenshot".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.78,
        };
    }

    if any_contains(
        &haystack,
        &[
            "course",
            "lecture",
            "assignment",
            "report",
            "paper",
            "comp",
            "math",
            "cs",
        ],
    ) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Study".to_string()),
                lifecycle: Some(if age_days <= 30 { "Active" } else { "Archive" }.to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some(
                    if age_days <= 30 {
                        "20_Areas/Study"
                    } else {
                        "40_Archive/{year}/Study"
                    }
                    .to_string(),
                ),
                context: Some(extract_study_context(&row.name)),
                ..RuleAction::default()
            },
            confidence: 0.72,
        };
    }

    if is_temporary_name(&haystack) {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Temporary".to_string()),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("90_Temporary".to_string()),
                context: Some("Temporary".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.72,
        };
    }

    if file_type == "Installer" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Installer".to_string()),
                lifecycle: Some("Disposable".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("90_Temporary/Installers".to_string()),
                context: Some("Installer".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.68,
        };
    }

    if file_type == "Image" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Media".to_string()),
                lifecycle: Some(if age_days <= 30 { "Active" } else { "Archive" }.to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some(
                    if age_days <= 30 {
                        "20_Areas/Media/Images"
                    } else {
                        "40_Archive/{year}/Media/Images"
                    }
                    .to_string(),
                ),
                context: Some("Image".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.72,
        };
    }

    if file_type == "Video" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Media".to_string()),
                lifecycle: Some(
                    if age_days <= 180 {
                        "Reference"
                    } else {
                        "Archive"
                    }
                    .to_string(),
                ),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some(
                    if age_days <= 180 {
                        "20_Areas/Media/Videos"
                    } else {
                        "40_Archive/{year}/Media/Videos"
                    }
                    .to_string(),
                ),
                context: Some("Video".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.72,
        };
    }

    if file_type == "Audio" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Media".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Media/Audio".to_string()),
                context: Some("Audio".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.70,
        };
    }

    if file_type == "Spreadsheet" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Work".to_string()),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Documents/Spreadsheets".to_string()),
                context: Some("Spreadsheet".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.68,
        };
    }

    if file_type == "Presentation" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some(
                    if any_contains(&haystack, &["lecture", "course", "class"]) {
                        "Study"
                    } else {
                        "Work"
                    }
                    .to_string(),
                ),
                lifecycle: Some("Reference".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("20_Areas/Documents/Presentations".to_string()),
                context: Some("Presentation".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.68,
        };
    }

    if file_type == "ArchivePackage" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Archive".to_string()),
                lifecycle: Some("Disposable".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("90_Temporary/Archives".to_string()),
                context: Some("Archive Package".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.66,
        };
    }

    if file_type == "Code" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some("Project".to_string()),
                lifecycle: Some("Active".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Review".to_string()),
                target_template: Some("20_Areas/Projects".to_string()),
                context: Some("Code".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.64,
        };
    }

    if file_type == "Document" {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some(document_purpose(&haystack).to_string()),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some("Move".to_string()),
                target_template: Some("00_Inbox/Documents".to_string()),
                context: Some("Document".to_string()),
                ..RuleAction::default()
            },
            confidence: 0.62,
        };
    }

    if any_contains(
        &haystack,
        &["temp", "tmp", "copy", "副本", "screenshot", "screen shot"],
    ) || is_inbox_directory(&parent_directory(&row.path))
    {
        return BuiltinClassification {
            action: RuleAction {
                purpose: Some(
                    if file_type == "Image" {
                        "Media"
                    } else {
                        "Temporary"
                    }
                    .to_string(),
                ),
                lifecycle: Some("Inbox".to_string()),
                risk_level: Some("Normal".to_string()),
                suggested_action: Some(
                    if file_type == "Image" {
                        "Rename"
                    } else {
                        "Move"
                    }
                    .to_string(),
                ),
                target_template: Some("00_Inbox".to_string()),
                rename_template: (file_type == "Image").then(|| "{basename}_{date}".to_string()),
                context: Some("Inbox".to_string()),
            },
            confidence: 0.62,
        };
    }

    BuiltinClassification {
        action: RuleAction {
            purpose: Some("Unknown".to_string()),
            lifecycle: Some(
                if age_days <= 14 {
                    "Active"
                } else {
                    "Reference"
                }
                .to_string(),
            ),
            risk_level: Some("Unknown".to_string()),
            suggested_action: Some("Keep".to_string()),
            target_template: Some(String::new()),
            context: Some(String::new()),
            ..RuleAction::default()
        },
        confidence: 0.45,
    }
}

fn any_contains(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn is_project_manifest(name: &str) -> bool {
    matches!(
        name,
        "package.json"
            | "cargo.toml"
            | "pom.xml"
            | "build.gradle"
            | "requirements.txt"
            | "pyproject.toml"
            | "go.mod"
    )
}

fn is_screenshot_name(haystack: &str) -> bool {
    any_contains(
        haystack,
        &[
            "screenshot",
            "screen shot",
            "截图",
            "屏幕截图",
            "微信图片",
            "微信截图",
        ],
    )
}

fn is_temporary_name(haystack: &str) -> bool {
    any_contains(
        haystack,
        &["temp", "tmp", "copy", "download", "副本", "未命名", "新建"],
    )
}

fn document_purpose(haystack: &str) -> &'static str {
    if any_contains(
        haystack,
        &["论文", "毕业", "lecture", "course", "assignment"],
    ) {
        "Study"
    } else if any_contains(haystack, &["personal", "家庭", "个人"]) {
        "Personal"
    } else {
        "Work"
    }
}

fn is_inbox_directory(directory: &str) -> bool {
    let normalized = directory.to_lowercase();
    normalized.contains("downloads") || normalized.contains("desktop")
}

fn extract_study_context(name: &str) -> String {
    name.split(|character: char| !character.is_ascii_alphanumeric())
        .find(|part| {
            let has_letters = part
                .chars()
                .any(|character| character.is_ascii_alphabetic());
            let has_digits = part.chars().any(|character| character.is_ascii_digit());
            (4..=10).contains(&part.len()) && has_letters && has_digits
        })
        .map(|part| part.to_ascii_uppercase())
        .unwrap_or_else(|| "Study".to_string())
}

pub(super) fn days_since_unix(mtime: i64) -> i64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(mtime);
    ((now - mtime).max(0)) / 86_400
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
