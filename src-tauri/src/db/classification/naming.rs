use super::super::*;
use std::path::PathBuf;

pub(crate) fn translate_template(template: &str, language: &str) -> String {
    if language != "zh" {
        return template.to_string();
    }

    template
        .replace("00_Inbox", "00_收件箱")
        .replace("20_Areas", "20_领域")
        .replace("40_Archive", "40_归档")
        .replace("90_Temporary", "90_临时")
        .replace("Personal/Identity", "个人/证件")
        .replace("Career", "职业")
        .replace("Finance", "财务")
        .replace("Study", "学业")
        .replace("Projects", "项目")
        .replace("Installers", "安装包")
        .replace("Media/Images", "媒体/图片")
        .replace("Media/Videos", "媒体/视频")
        .replace("Media/Audio", "媒体/音频")
        .replace("Documents/Spreadsheets", "文档/表格")
        .replace("Documents/Presentations", "文档/演示")
        .replace("Documents", "文档")
        .replace("Screenshots", "截图")
        .replace("Archives", "压缩包")
        .replace("Packages", "软件包")
}

pub(crate) fn build_target_path(
    row: &IndexedFileRow,
    file_type: &str,
    template: Option<&str>,
    folder_naming_language: &str,
) -> String {
    let Some(template) = template.filter(|value| !value.is_empty()) else {
        return String::new();
    };
    let year = unix_seconds_to_iso(row.mtime)
        .get(0..4)
        .unwrap_or("1970")
        .to_string();
    let translated_template = translate_template(template, folder_naming_language);
    let resolved = translated_template
        .replace("{year}", &year)
        .replace("{type}", file_type);
    let mut target = PathBuf::from(parent_directory(&row.path));
    target.push("ZenCanvas");
    for segment in resolved
        .split(['/', '\\'])
        .filter(|segment| !segment.is_empty())
    {
        target.push(segment);
    }
    target.to_string_lossy().to_string()
}

pub(crate) fn build_suggested_name(row: &IndexedFileRow, template: Option<&str>) -> String {
    let Some(template) = template.filter(|value| !value.is_empty()) else {
        return row.name.clone();
    };
    let basename = clean_name(file_stem(&row.name, &row.extension));
    let date = unix_seconds_to_iso(row.mtime)
        .get(0..10)
        .unwrap_or("1970-01-01")
        .replace('-', "");
    let extension = row.extension.trim_start_matches('.');
    let suffix = if extension.is_empty() {
        String::new()
    } else {
        format!(".{extension}")
    };
    format!(
        "{}{}",
        template
            .replace("{basename}", &basename)
            .replace("{date}", &date)
            .replace("{extension}", extension),
        suffix
    )
}

fn file_stem<'a>(name: &'a str, extension: &str) -> &'a str {
    let extension = extension.trim_start_matches('.');
    if extension.is_empty() {
        return name;
    }
    let suffix = format!(".{extension}");
    if name.to_lowercase().ends_with(&suffix.to_lowercase()) && name.len() > suffix.len() {
        &name[..name.len() - suffix.len()]
    } else {
        name
    }
}

fn clean_name(value: &str) -> String {
    let mut output = String::new();
    let mut last_was_separator = false;
    for character in value.trim().chars() {
        if character.is_alphanumeric() || ('\u{4e00}'..='\u{9fff}').contains(&character) {
            output.extend(character.to_lowercase());
            last_was_separator = false;
        } else if !last_was_separator {
            output.push('_');
            last_was_separator = true;
        }
    }
    output.trim_matches('_').to_string()
}
