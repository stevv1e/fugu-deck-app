//! Fugu Deck для Windows: то же приложение (сборка Expo для веба) в окне WebView2, а всё, что требует ОС, — здесь:
//! ключи устройства в TPM, Windows Hello, секреты под DPAPI, HTTP с mTLS, файлы и ссылки fugudeck://.
//! Команды повторяют интерфейс нативного модуля fd-secure мобильного приложения (src/platform/desktop.ts).
mod der;
mod files;
mod hello;
mod keys;
mod net;
mod secrets;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use base64::{engine::general_purpose::STANDARD as B64S, engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_deep_link::DeepLinkExt;

struct App {
    data: PathBuf,
    net: Arc<net::Net>,
    files: files::Files,
    links: Mutex<Vec<String>>,
}

type R<T> = Result<T, String>;

fn meta_file(a: &App) -> PathBuf {
    a.data.join("keys.json")
}

fn meta(a: &App) -> HashMap<String, bool> {
    std::fs::read(meta_file(a)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn set_meta(a: &App, alias: &str, confirm: Option<bool>) -> R<()> {
    let mut m = meta(a);
    match confirm {
        Some(c) => m.insert(alias.to_string(), c),
        None => m.remove(alias),
    };
    std::fs::create_dir_all(&a.data).map_err(|e| e.to_string())?;
    std::fs::write(meta_file(a), serde_json::to_vec(&m).unwrap()).map_err(|e| e.to_string())
}

fn hwnd(w: &WebviewWindow) -> isize {
    #[cfg(windows)]
    {
        w.hwnd().map(|h| h.0 as isize).unwrap_or(0)
    }
    #[cfg(not(windows))]
    {
        let _ = w;
        0
    }
}

#[tauri::command]
fn capabilities() -> Value {
    json!({"platform": "windows", "hardware": keys::tpm_available(), "strongbox": false,
           "biometry": hello::available(), "mtls": true, "appAttest": false})
}

#[tauri::command]
async fn generate_key(app: State<'_, App>, w: WebviewWindow, alias: String, require_biometry: bool) -> R<keys::KeyInfo> {
    if require_biometry {
        // ключ подтверждения без Windows Hello не создаём: иначе подпись не спрашивала бы человека
        let h = hwnd(&w);
        tauri::async_runtime::spawn_blocking(move || hello::verify(h, "Fugu Deck: создать ключ подтверждения этого компьютера")).await.map_err(|e| e.to_string())??;
    }
    let a = alias.clone();
    let info = tauri::async_runtime::spawn_blocking(move || keys::generate(&a)).await.map_err(|e| e.to_string())??;
    set_meta(&app, &alias, Some(require_biometry))?;
    Ok(info)
}

#[tauri::command]
fn public_key(alias: String) -> Option<keys::KeyInfo> {
    keys::public(&alias)
}

/// Подпись ES256: data — base64url, ответ — DER в base64 (как у fd-secure).
#[tauri::command]
async fn sign(app: State<'_, App>, w: WebviewWindow, alias: String, data: String, prompt: Option<String>) -> R<String> {
    let bytes = B64.decode(data.trim_end_matches('=')).map_err(|_| "данные для подписи повреждены")?;
    let needs_hello = meta(&app).get(&alias).copied().unwrap_or(false) || prompt.is_some();
    let h = hwnd(&w);
    tauri::async_runtime::spawn_blocking(move || {
        if needs_hello {
            hello::verify(h, prompt.as_deref().unwrap_or("Подтвердите действие"))?;
        }
        let raw = keys::sign_digest(&alias, &Sha256::digest(&bytes))?;
        Ok(B64S.encode(der::raw_to_der(&raw)))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn delete_key(app: State<'_, App>, alias: String) -> R<()> {
    let _ = keys::delete(&alias);
    set_meta(&app, &alias, None)
}

#[tauri::command]
fn set_client_certificate(app: State<'_, App>, alias: String, cert_pem: String) -> R<bool> {
    app.net.set_cert(&alias, &cert_pem)?;
    Ok(true)
}

#[tauri::command]
async fn request(app: State<'_, App>, req: net::Req) -> R<net::Resp> {
    app.net.request(req).await
}

#[tauri::command]
fn open_stream(app: State<'_, App>, handle: AppHandle, id: String, req: net::Req) {
    app.net.open_stream(handle, id, req);
}

#[tauri::command]
fn close_stream(app: State<'_, App>, id: String) {
    app.net.close_stream(&id);
}

#[tauri::command]
async fn hello_verify(w: WebviewWindow, message: String) -> R<()> {
    let h = hwnd(&w);
    tauri::async_runtime::spawn_blocking(move || hello::verify(h, &message)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn secret_get(app: State<'_, App>, key: String) -> R<Option<String>> {
    secrets::get(&app.data.join("secrets"), &key)
}

#[tauri::command]
fn secret_set(app: State<'_, App>, key: String, value: String) -> R<()> {
    secrets::set(&app.data.join("secrets"), &key, &value)
}

#[tauri::command]
fn secret_del(app: State<'_, App>, key: String) -> R<()> {
    secrets::del(&app.data.join("secrets"), &key)
}

#[tauri::command]
async fn pick_files(app: State<'_, App>, w: WebviewWindow, images: bool, multiple: bool) -> R<Vec<files::Picked>> {
    let mut d = rfd::AsyncFileDialog::new().set_parent(&w);
    if images {
        d = d.add_filter("Изображения", &["jpg", "jpeg", "png", "webp", "gif", "heic", "bmp"]);
    }
    let paths: Vec<PathBuf> = if multiple {
        d.pick_files().await.unwrap_or_default().into_iter().map(|f| f.path().to_path_buf()).collect()
    } else {
        d.pick_file().await.into_iter().map(|f| f.path().to_path_buf()).collect()
    };
    Ok(app.files.picked(paths))
}

/// Окно «Сохранить как»; путь становится доступен для записи.
#[tauri::command]
async fn save_dialog(app: State<'_, App>, w: WebviewWindow, name: String) -> R<Option<String>> {
    let f = rfd::AsyncFileDialog::new().set_parent(&w).set_file_name(&name).save_file().await;
    Ok(f.map(|f| {
        let p = f.path().to_path_buf();
        app.files.allow(&p);
        p.to_string_lossy().into_owned()
    }))
}

#[tauri::command]
fn read_chunk(app: State<'_, App>, path: String, position: u64, length: u64) -> R<String> {
    app.files.read_chunk(&path, position, length)
}

#[tauri::command]
fn file_size(app: State<'_, App>, path: String) -> R<u64> {
    app.files.size(&path)
}

#[tauri::command]
fn write_file(app: State<'_, App>, path: String, data: String, append: bool) -> R<()> {
    app.files.write(&path, &data, append)
}

#[tauri::command]
fn remove_file(app: State<'_, App>, path: String) -> R<()> {
    app.files.remove(&path)
}

#[tauri::command]
fn cache_path(app: State<'_, App>, name: String) -> R<String> {
    app.files.cache_path(&name)
}

/// Открыть файл программой по умолчанию — только выбранный человеком или из кэша вложений.
#[tauri::command]
fn open_file(app: State<'_, App>, path: String) -> R<()> {
    app.files.size(&path)?;
    tauri_plugin_opener::open_path(path, None::<&str>).map_err(|e| e.to_string())
}

/// Открыть адрес во внешнем браузере (вход через Keycloak): только https.
#[tauri::command]
fn open_url(url: String) -> R<()> {
    if !url.starts_with("https://") {
        return Err("только https".into());
    }
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Ссылки fugudeck://, с которыми приложение запустили (дальше они приходят событием "fd-link").
#[tauri::command]
fn take_links(app: State<'_, App>) -> Vec<String> {
    std::mem::take(&mut *app.links.lock().unwrap())
}

fn deliver(h: &AppHandle, urls: Vec<String>) {
    let urls: Vec<String> = urls.into_iter().filter(|u| u.starts_with("fugudeck://")).collect();
    if urls.is_empty() {
        return;
    }
    if let Some(a) = h.try_state::<App>() {
        a.links.lock().unwrap().extend(urls.iter().cloned());
    }
    let _ = h.emit("fd-link", urls);
    if let Some(w) = h.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

pub fn run() {
    tauri::Builder::default()
        // второй запуск (по ссылке fugudeck:// из браузера) отдаёт ссылку первому окну и закрывается
        .plugin(tauri_plugin_single_instance::init(|h, argv, _| deliver(h, argv)))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let data = app.path().app_local_data_dir()?;
            let cache = app.path().app_cache_dir()?;
            app.manage(App {
                net: Arc::new(net::Net::new(data.join("certs"))),
                files: files::Files::new(cache),
                links: Mutex::new(Vec::new()),
                data,
            });
            #[cfg(windows)]
            {
                // схема fugudeck:// — на пользователя, без прав администратора
                let _ = app.deep_link().register_all();
            }
            let h = app.handle().clone();
            app.deep_link().on_open_url(move |e| deliver(&h, e.urls().iter().map(|u| u.to_string()).collect()));
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                deliver(app.handle(), urls.iter().map(|u| u.to_string()).collect());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            capabilities, generate_key, public_key, sign, delete_key, set_client_certificate, request, open_stream, close_stream,
            hello_verify, secret_get, secret_set, secret_del, pick_files, save_dialog, read_chunk, file_size, write_file, remove_file,
            cache_path, open_file, open_url, take_links
        ])
        .run(tauri::generate_context!())
        .expect("не удалось запустить Fugu Deck");
}
