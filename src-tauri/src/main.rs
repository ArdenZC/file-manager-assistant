#![cfg_attr(
    all(not(debug_assertions), target_os = "windows"),
    windows_subsystem = "windows"
)]

use std::{
    io,
    sync::{atomic::AtomicBool, Arc},
};

use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;
use zen_canvas_tauri::{
    open_database, settings,
    watcher::{reload_file_watcher_for_settings, FileWatcherManager},
    OperationCancellationToken, ScanCancellationToken,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .setup(|app| {
            let db = open_database(&app.handle())
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            app.manage(db.clone());
            app.manage(ScanCancellationToken(Arc::new(AtomicBool::new(false))));
            app.manage(OperationCancellationToken(Arc::new(AtomicBool::new(false))));
            app.manage(FileWatcherManager::default());
            zen_canvas_tauri::app_control::setup_tray(app)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            zen_canvas_tauri::app_control::setup_search_window(app)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            zen_canvas_tauri::app_control::setup_global_search_shortcut(app)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            let app_settings = settings::get_app_settings(&db)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            let launch_at_login = app.autolaunch();
            let app_settings = match settings::sync_launch_at_login_from_system(
                &db,
                &app_settings,
                &*launch_at_login,
            ) {
                Ok(synced_settings) => synced_settings,
                Err(error) => {
                    eprintln!("Launch at login sync failed (non-fatal): {error}");
                    app_settings
                }
            };
            db.prune_operation_logs(app_settings.restore_retention_days)
                .map_err(|error| io::Error::new(io::ErrorKind::Other, error))?;
            let watcher_manager = app.state::<FileWatcherManager>();
            if let Err(error) = reload_file_watcher_for_settings(
                app.handle().clone(),
                &watcher_manager,
                &app_settings,
            ) {
                eprintln!("File watcher init failed (non-fatal): {error}");
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
            zen_canvas_tauri::db::execute_rules_for_scope,
            zen_canvas_tauri::settings::get_settings,
            zen_canvas_tauri::settings::save_settings,
            zen_canvas_tauri::app_control::quit_app,
            zen_canvas_tauri::app_control::activate_search_result,
            zen_canvas_tauri::scanner::scan_directory,
            zen_canvas_tauri::scanner::cancel_scan,
            zen_canvas_tauri::file_ops::move_file,
            zen_canvas_tauri::file_ops::rename_file,
            zen_canvas_tauri::file_ops::reveal_in_folder,
            zen_canvas_tauri::file_ops::execute_moves,
            zen_canvas_tauri::file_ops::restore_moves,
            zen_canvas_tauri::file_ops::cancel_operations
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Zen Canvas");
}
