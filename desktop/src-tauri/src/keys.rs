//! Ключи устройства в TPM (Microsoft Platform Crypto Provider): P-256, создаются в чипе и не выводятся из него.
//! Нет TPM — программный провайдер Windows (ключ на диске, защищён DPAPI), и приложение честно пишет «software».
//! Ключ подтверждения перед каждой подписью спрашивает Windows Hello (PIN, отпечаток, лицо).
use serde::Serialize;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    pub public_key: String, // 0x04‖X‖Y, base64url
    pub storage: String,    // "tpm" | "software"
    pub attestation: Option<serde_json::Value>,
}

#[cfg(windows)]
mod imp {
    use super::KeyInfo;
    use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
    use windows::core::{HSTRING, PCWSTR};
    use windows::Win32::Security::Cryptography::*;

    const PREFIX: &str = "FuguDeck.";

    struct Prov(NCRYPT_PROV_HANDLE);
    impl Drop for Prov {
        fn drop(&mut self) {
            unsafe {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.0 .0));
            }
        }
    }
    struct Key(NCRYPT_KEY_HANDLE);
    impl Drop for Key {
        fn drop(&mut self) {
            unsafe {
                let _ = NCryptFreeObject(NCRYPT_HANDLE(self.0 .0));
            }
        }
    }

    fn prov(tpm: bool) -> Result<Prov, String> {
        let mut h = NCRYPT_PROV_HANDLE::default();
        let name = if tpm { MS_PLATFORM_CRYPTO_PROVIDER } else { MS_KEY_STORAGE_PROVIDER };
        unsafe { NCryptOpenStorageProvider(&mut h, name, 0) }.map_err(|e| format!("хранилище ключей Windows: {e}"))?;
        Ok(Prov(h))
    }

    pub fn tpm_available() -> bool {
        prov(true).is_ok()
    }

    fn name(alias: &str) -> HSTRING {
        HSTRING::from(format!("{PREFIX}{alias}"))
    }

    fn open(alias: &str) -> Result<(Key, bool), String> {
        for tpm in [true, false] {
            if let Ok(p) = prov(tpm) {
                let mut k = NCRYPT_KEY_HANDLE::default();
                let n = name(alias);
                if unsafe { NCryptOpenKey(p.0, &mut k, PCWSTR(n.as_ptr()), CERT_KEY_SPEC(0), NCRYPT_FLAGS(0)) }.is_ok() {
                    return Ok((Key(k), tpm));
                }
            }
        }
        Err(format!("ключа {alias} нет"))
    }

    fn export(k: &Key) -> Result<String, String> {
        let mut len = 0u32;
        unsafe { NCryptExportKey(k.0, NCRYPT_KEY_HANDLE::default(), BCRYPT_ECCPUBLIC_BLOB, None, None, &mut len, NCRYPT_FLAGS(0)) }
            .map_err(|e| format!("открытый ключ: {e}"))?;
        let mut buf = vec![0u8; len as usize];
        unsafe { NCryptExportKey(k.0, NCRYPT_KEY_HANDLE::default(), BCRYPT_ECCPUBLIC_BLOB, None, Some(&mut buf), &mut len, NCRYPT_FLAGS(0)) }
            .map_err(|e| format!("открытый ключ: {e}"))?;
        // BCRYPT_ECCKEY_BLOB: magic (4), cbKey (4), X, Y
        let cb = u32::from_le_bytes(buf[4..8].try_into().unwrap()) as usize;
        if cb != 32 || buf.len() < 8 + 2 * cb {
            return Err("не тот ключ: ждали P-256".into());
        }
        let mut point = vec![4u8];
        point.extend_from_slice(&buf[8..8 + 2 * cb]);
        Ok(B64.encode(point))
    }

    pub fn generate(alias: &str) -> Result<KeyInfo, String> {
        let _ = delete(alias);
        let mut last = String::new();
        for tpm in [true, false] {
            let p = match prov(tpm) {
                Ok(p) => p,
                Err(e) => {
                    last = e;
                    continue;
                }
            };
            let mut k = NCRYPT_KEY_HANDLE::default();
            let n = name(alias);
            let made = unsafe {
                NCryptCreatePersistedKey(p.0, &mut k, BCRYPT_ECDSA_P256_ALGORITHM, PCWSTR(n.as_ptr()), CERT_KEY_SPEC(0), NCRYPT_OVERWRITE_KEY_FLAG)
            };
            if let Err(e) = made {
                last = format!("создание ключа: {e}");
                continue;
            }
            let k = Key(k);
            // экспорт закрытого ключа запрещён (по умолчанию так и есть; задаём явно)
            let policy = 0u32.to_le_bytes();
            unsafe {
                let _ = NCryptSetProperty(NCRYPT_HANDLE(k.0 .0), NCRYPT_EXPORT_POLICY_PROPERTY, &policy, NCRYPT_PERSIST_FLAG);
            }
            if let Err(e) = unsafe { NCryptFinalizeKey(k.0, NCRYPT_FLAGS(0)) } {
                last = format!("создание ключа: {e}");
                continue;
            }
            return Ok(KeyInfo { public_key: export(&k)?, storage: if tpm { "tpm" } else { "software" }.into(), attestation: None });
        }
        Err(last)
    }

    pub fn public(alias: &str) -> Option<KeyInfo> {
        let (k, tpm) = open(alias).ok()?;
        Some(KeyInfo { public_key: export(&k).ok()?, storage: if tpm { "tpm" } else { "software" }.into(), attestation: None })
    }

    /// Подпись готового SHA-256: r‖s.
    pub fn sign_digest(alias: &str, digest: &[u8]) -> Result<Vec<u8>, String> {
        let (k, _) = open(alias)?;
        let mut len = 0u32;
        unsafe { NCryptSignHash(k.0, None, digest, None, &mut len, NCRYPT_SILENT_FLAG) }.map_err(|e| format!("подпись: {e}"))?;
        let mut sig = vec![0u8; len as usize];
        unsafe { NCryptSignHash(k.0, None, digest, Some(&mut sig), &mut len, NCRYPT_SILENT_FLAG) }.map_err(|e| format!("подпись: {e}"))?;
        sig.truncate(len as usize);
        Ok(sig)
    }

    pub fn delete(alias: &str) -> Result<(), String> {
        let (k, _) = open(alias)?;
        let h = k.0;
        std::mem::forget(k); // NCryptDeleteKey сам освобождает дескриптор
        unsafe { NCryptDeleteKey(h, 0) }.map_err(|e| format!("удаление ключа: {e}"))
    }
}

#[cfg(not(windows))]
mod imp {
    //! Не Windows — только чтобы проект собирался и проверялся на машине разработки.
    use super::KeyInfo;
    const NO: &str = "ключи устройства есть только в сборке для Windows";
    pub fn tpm_available() -> bool {
        false
    }
    pub fn generate(_: &str) -> Result<KeyInfo, String> {
        Err(NO.into())
    }
    pub fn public(_: &str) -> Option<KeyInfo> {
        None
    }
    pub fn sign_digest(_: &str, _: &[u8]) -> Result<Vec<u8>, String> {
        Err(NO.into())
    }
    pub fn delete(_: &str) -> Result<(), String> {
        Err(NO.into())
    }
}

pub use imp::*;
