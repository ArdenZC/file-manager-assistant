use std::{collections::HashSet, ffi::OsStr, sync::OnceLock};

pub fn is_ignored_dir_name(name: &OsStr) -> bool {
    let name = name.to_string_lossy();
    let lower = name.to_ascii_lowercase();
    let lower = lower.as_str();

    skip_dir_names().contains(lower) || has_generated_dir_variant(lower)
}

fn skip_dir_names() -> &'static HashSet<&'static str> {
    static SKIP_DIR_NAMES: OnceLock<HashSet<&'static str>> = OnceLock::new();
    SKIP_DIR_NAMES.get_or_init(|| {
        [
            ".git",
            ".hg",
            ".svn",
            ".idea",
            ".vscode",
            ".cache",
            ".parcel-cache",
            ".turbo",
            ".next",
            ".nuxt",
            ".venv",
            "__pycache__",
            "node_modules",
            "target",
            "dist",
            "build",
            "coverage",
            "vendor",
            "venv",
            "pods",
            "deriveddata",
            "appdata",
            "library",
            "system volume information",
            "$recycle.bin",
            "windows",
            "program files",
            "program files (x86)",
            "programdata",
            "$windows.~bt",
            "$winreagent",
            "recovery",
        ]
        .into_iter()
        .collect()
    })
}

fn has_generated_dir_variant(lower: &str) -> bool {
    const VARIANT_BASES: &[&str] = &[".git", ".cache", "__pycache__", "node_modules"];
    VARIANT_BASES.iter().any(|base| {
        lower
            .strip_prefix(base)
            .is_some_and(|suffix| matches!(suffix.as_bytes().first(), Some(b'.' | b'-' | b'_')))
    })
}
