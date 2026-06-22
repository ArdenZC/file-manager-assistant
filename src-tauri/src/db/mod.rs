mod classification;
mod commands;
mod connection;
mod queries;
mod schema;
mod types;
pub(crate) use classification::normalized_file_type;
#[cfg(test)]
pub(crate) use classification::{rule_version_for_rules, translate_template};
pub use commands::*;
pub use connection::Database;
pub(crate) use queries::{
    bool_to_i64, current_unix_seconds, indexed_file_from_row, infer_file_type, normalize_path_text,
    optimize_search_index_after_bulk_upsert, parent_directory, path_lookup_candidates, push_unique,
    scoped_files_sql, trim_trailing_path_separators, unix_seconds_to_iso,
};
#[cfg(test)]
pub(crate) use queries::{build_fts_query, upsert_files_by_paths_with_optional_optimize};
pub use queries::{
    emit_search_index_optimized, run_search_index_optimize, upsert_files_by_paths_for_db,
};
pub use types::*;

const CLASSIFY_BATCH_SIZE: usize = 500;
const OPTIMIZE_AFTER_UPSERT_THRESHOLD: usize = 500;
pub const SEARCH_INDEX_OPTIMIZED_EVENT: &str = "search-index-optimized";

const CLASSIFICATION_STATUS_UNCLASSIFIED: &str = "unclassified";
const CLASSIFICATION_STATUS_CLASSIFIED: &str = "classified";

#[cfg(test)]
mod tests;
