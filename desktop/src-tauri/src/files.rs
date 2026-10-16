//! Файлы: выбор, чтение кусками для загрузки, сохранение и открытие. Читать и писать можно только то, что выбрал
//! человек в системном окне, и кэш вложений приложения — не произвольные пути из WebView.
use std::collections::HashSet;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;

#[derive(Serialize)]
pub struct Picked {
    pub uri: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

pub struct Files {
    pub cache: PathBuf,
    allowed: Mutex<HashSet<PathBuf>>,
}

impl Files {
    pub fn new(cache: PathBuf) -> Self {
        Self { cache, allowed: Mutex::new(HashSet::new()) }
    }

    fn check(&self, p: &str) -> Result<PathBuf, String> {
        let path = PathBuf::from(p);
        if path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
            return Err("недопустимый путь".into());
        }
        if path.starts_with(&self.cache) || self.allowed.lock().unwrap().contains(&path) {
            Ok(path)
        } else {
            Err("к этому файлу нет доступа".into())
        }
    }

    pub fn allow(&self, p: &Path) {
        self.allowed.lock().unwrap().insert(p.to_path_buf());
    }

    pub fn picked(&self, paths: Vec<PathBuf>) -> Vec<Picked> {
        paths
            .into_iter()
            .filter_map(|p| {
                let size = std::fs::metadata(&p).ok()?.len();
                self.allow(&p);
                Some(Picked {
                    name: p.file_name()?.to_string_lossy().into_owned(),
                    mime: mime_guess::from_path(&p).first_or_octet_stream().essence_str().to_string(),
                    uri: p.to_string_lossy().into_owned(),
                    size,
                })
            })
            .collect()
    }

    pub fn read_chunk(&self, p: &str, pos: u64, len: u64) -> Result<String, String> {
        let mut f = std::fs::File::open(self.check(p)?).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        f.take(len).read_to_end(&mut buf).map_err(|e| e.to_string())?;
        Ok(B64.encode(buf))
    }

    pub fn size(&self, p: &str) -> Result<u64, String> {
        Ok(std::fs::metadata(self.check(p)?).map_err(|e| e.to_string())?.len())
    }

    pub fn write(&self, p: &str, b64: &str, append: bool) -> Result<(), String> {
        let path = self.check(p)?;
        if let Some(d) = path.parent() {
            std::fs::create_dir_all(d).map_err(|e| e.to_string())?;
        }
        let data = B64.decode(b64).map_err(|_| "данные повреждены")?;
        let mut f = std::fs::OpenOptions::new().create(true).write(true).append(append).truncate(!append).open(path).map_err(|e| e.to_string())?;
        f.write_all(&data).map_err(|e| e.to_string())
    }

    pub fn remove(&self, p: &str) -> Result<(), String> {
        let _ = std::fs::remove_file(self.check(p)?);
        Ok(())
    }

    pub fn cache_path(&self, name: &str) -> Result<String, String> {
        let safe: String = name.chars().map(|c| if "/\\:*?\"<>|".contains(c) || c.is_control() { '_' } else { c }).take(150).collect();
        if safe.is_empty() || safe == "." || safe == ".." {
            return Err("имя файла".into());
        }
        Ok(self.cache.join("attachments").join(safe).to_string_lossy().into_owned())
    }
}
