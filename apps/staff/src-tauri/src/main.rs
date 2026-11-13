// TiVBook Staff — Windows desktop shell.
// The interface is the same online staff software; all data lives in the online
// backend, so every installed PC and the player app stay in sync.
// Phase 8 adds a native command here to send ESC/POS tickets to the Epson TM-T88V.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running TiVBook Staff");
}
