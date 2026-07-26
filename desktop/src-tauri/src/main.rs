#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::pick_project_folder,
            commands::scan_project,
            commands::list_source_files,
            commands::list_cs_files,
            commands::read_text_file,
            commands::read_ide_bridge_discovery,
            commands::write_text_file,
            commands::delete_text_file,
            commands::run_dotnet_test,
            commands::run_test_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AITest Desktop");
}
