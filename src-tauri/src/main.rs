use std::{
    io,
    sync::{atomic::AtomicBool, Arc},
};

use tauri::Manager;
use zen_canvas_tauri::{open_database, settings, ScanCancellationToken};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let db = open_database(&app.handle())
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            app.manage(db.clone());
            let app_settings = settings::get_app_settings(&db)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            db.prune_operation_logs(app_settings.restore_retention_days)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            app.manage(ScanCancellationToken(Arc::new(AtomicBool::new(false))));
            // 构建默认监听路径：用户主目录下设置启用的个人文件夹
            let home = dirs::home_dir();
            let watch_paths: Vec<std::path::PathBuf> =
                zen_canvas_tauri::watcher::watch_paths_from_default_scan_folders(
                    home.as_deref(),
                    &app_settings.default_scan_folders,
                )
                .into_iter()
                .filter(|p| p.exists())
                .collect();
            if !watch_paths.is_empty() {
                if let Err(e) =
                    zen_canvas_tauri::watcher::setup_file_watcher(app.handle().clone(), watch_paths)
                {
                    eprintln!("File watcher init failed (non-fatal): {e}");
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            zen_canvas_tauri::db::init_db,
            zen_canvas_tauri::db::insert_file,
            zen_canvas_tauri::db::remove_files_by_paths,
            zen_canvas_tauri::db::upsert_files_by_paths,
            zen_canvas_tauri::db::search_files,
            zen_canvas_tauri::db::get_paged_files,
            zen_canvas_tauri::db::get_stats_summary,
            zen_canvas_tauri::db::get_operation_logs,
            zen_canvas_tauri::db::get_user_rules,
            zen_canvas_tauri::db::save_user_rule,
            zen_canvas_tauri::db::delete_user_rule,
            zen_canvas_tauri::db::execute_rules_on_inbox,
            zen_canvas_tauri::db::execute_rules_for_paths,
            zen_canvas_tauri::settings::get_settings,
            zen_canvas_tauri::settings::save_settings,
            zen_canvas_tauri::app_control::quit_app,
            zen_canvas_tauri::scanner::scan_directory,
            zen_canvas_tauri::scanner::cancel_scan,
            zen_canvas_tauri::file_ops::move_file,
            zen_canvas_tauri::file_ops::rename_file,
            zen_canvas_tauri::file_ops::reveal_in_folder,
            zen_canvas_tauri::file_ops::execute_moves,
            zen_canvas_tauri::file_ops::restore_moves
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Zen Canvas");
}
