// Fugu Local для Windows: то же веб-приложение (local/dist) в окне WebView2. Сервера нет — запросы к моделям идут
// с этого компьютера прямо провайдеру через плагин http; ключи лежат в диспетчере учётных данных Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

const SERVICE: &str = "kz.fugudeck.local";

/// Только ключи этого приложения: имя вида fl.key.<провайдер>, чтобы окно не читало чужие учётные данные.
fn entry(name: &str) -> Result<keyring::Entry, String> {
    let ok = name.len() <= 40
        && name.starts_with("fl.key.")
        && name["fl.key.".len()..].chars().all(|c| c.is_ascii_lowercase());
    if !ok {
        return Err("недопустимое имя ключа".into());
    }
    keyring::Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_get(name: String) -> Result<Option<String>, String> {
    match entry(&name)?.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> {
    if value.is_empty() || value.len() > 512 {
        return Err("ключ пустой или слишком длинный".into());
    }
    entry(&name)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn secret_del(name: String) -> Result<(), String> {
    match entry(&name)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![secret_get, secret_set, secret_del])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Fugu Local");
}
