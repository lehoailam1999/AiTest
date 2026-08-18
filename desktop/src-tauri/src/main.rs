#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod ai_cli;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::pick_project_folder,
            commands::scan_project,
            commands::list_source_files,
            commands::list_cs_files,
            commands::read_text_file,
            commands::read_unit_draft_text,
            commands::write_unit_draft_text,
            commands::delete_unit_draft_dir,
            commands::read_ide_bridge_discovery,
            commands::read_all_ide_bridge_discoveries,
            commands::check_ide_extension_status,
            commands::install_ide_extension_native,
            commands::write_text_file,
            commands::delete_text_file,
            commands::delete_dir,
            commands::run_dotnet_test,
            commands::run_test_command,
            commands::open_path_in_os,
            commands::pick_executable_file,
            ai_cli::ai_cli_which,
            ai_cli::ai_cli_is_file,
            ai_cli::ai_cli_run_version,
            ai_cli::ai_cli_user_env,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AITest Desktop");
}
