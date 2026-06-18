use std::io;

use tauri::Manager;
use zen_canvas_tauri::open_database;

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let db = open_database(&app.handle())
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            app.manage(db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            zen_canvas_tauri::db::init_db,
            zen_canvas_tauri::db::insert_file,
            zen_canvas_tauri::db::search_files,
            zen_canvas_tauri::db::get_paged_files,
            zen_canvas_tauri::db::get_stats_summary,
            zen_canvas_tauri::db::execute_rules_on_inbox,
            zen_canvas_tauri::scanner::scan_directory,
            zen_canvas_tauri::file_ops::move_file,
            zen_canvas_tauri::file_ops::rename_file,
            zen_canvas_tauri::file_ops::execute_moves
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Zen Canvas");
}
