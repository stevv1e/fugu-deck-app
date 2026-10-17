//! Секреты приложения (токены обновления кластеров): файлы, зашифрованные DPAPI для текущего пользователя Windows.
use std::path::{Path, PathBuf};

fn file(dir: &Path, key: &str) -> Result<PathBuf, String> {
    if key.is_empty() || key.len() > 200 || !key.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
        return Err("недопустимое имя секрета".into());
    }
    Ok(dir.join(format!("{key}.bin")))
}

#[cfg(windows)]
fn protect(data: &[u8], seal: bool) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::*;
    let input = CRYPT_INTEGER_BLOB { cbData: data.len() as u32, pbData: data.as_ptr() as *mut u8 };
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        if seal {
            CryptProtectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        } else {
            CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut out)
        }
    }
    .map_err(|e| format!("DPAPI: {e}"))?;
    let v = unsafe { std::slice::from_raw_parts(out.pbData, out.cbData as usize) }.to_vec();
    unsafe {
        let _ = LocalFree(HLOCAL(out.pbData as _));
    }
    Ok(v)
}

#[cfg(not(windows))]
fn protect(data: &[u8], _: bool) -> Result<Vec<u8>, String> {
    Ok(data.to_vec())
}

pub fn get(dir: &Path, key: &str) -> Result<Option<String>, String> {
    match std::fs::read(file(dir, key)?) {
        Ok(b) => Ok(Some(String::from_utf8(protect(&b, false)?).map_err(|_| "секрет повреждён")?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

pub fn set(dir: &Path, key: &str, value: &str) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    std::fs::write(file(dir, key)?, protect(value.as_bytes(), true)?).map_err(|e| e.to_string())
}

pub fn del(dir: &Path, key: &str) -> Result<(), String> {
    match std::fs::remove_file(file(dir, key)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.to_string()),
        _ => Ok(()),
    }
}
