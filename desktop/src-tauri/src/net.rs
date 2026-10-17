//! HTTP приложения. Все запросы идут отсюда, а не из WebView: так нет CORS, а к api.<домен> — mTLS, где TLS-рукопожатие
//! подписывает ключ сессии в TPM (закрытый ключ из чипа не выходит). Потоки (SSE) — событиями "fd-stream".
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use rustls::client::ResolvesClientCert;
use rustls::pki_types::CertificateDer;
use rustls::sign::{CertifiedKey, Signer, SigningKey};
use rustls::{SignatureAlgorithm, SignatureScheme};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};

use crate::{der, keys};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Req {
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub cert_alias: Option<String>,
    pub timeout_ms: Option<u64>,
}

#[derive(Serialize)]
pub struct Resp {
    pub status: u16,
    pub body: String,
}

#[derive(Debug)]
struct TpmKey(String);
#[derive(Debug)]
struct TpmSigner(String);

impl SigningKey for TpmKey {
    fn choose_scheme(&self, offered: &[SignatureScheme]) -> Option<Box<dyn Signer>> {
        offered.contains(&SignatureScheme::ECDSA_NISTP256_SHA256).then(|| Box::new(TpmSigner(self.0.clone())) as Box<dyn Signer>)
    }
    fn algorithm(&self) -> SignatureAlgorithm {
        SignatureAlgorithm::ECDSA
    }
}

impl Signer for TpmSigner {
    fn sign(&self, message: &[u8]) -> Result<Vec<u8>, rustls::Error> {
        let raw = keys::sign_digest(&self.0, &Sha256::digest(message)).map_err(rustls::Error::General)?;
        Ok(der::raw_to_der(&raw))
    }
    fn scheme(&self) -> SignatureScheme {
        SignatureScheme::ECDSA_NISTP256_SHA256
    }
}

#[derive(Debug)]
struct Resolver(Arc<CertifiedKey>);
impl ResolvesClientCert for Resolver {
    fn resolve(&self, _: &[&[u8]], _: &[SignatureScheme]) -> Option<Arc<CertifiedKey>> {
        Some(self.0.clone())
    }
    fn has_certs(&self) -> bool {
        true
    }
}

pub struct Net {
    certs: PathBuf,
    clients: Mutex<HashMap<String, reqwest::Client>>,
    streams: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

fn roots() -> rustls::RootCertStore {
    rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() }
}

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

impl Net {
    pub fn new(certs: PathBuf) -> Self {
        Self { certs, clients: Mutex::new(HashMap::new()), streams: Mutex::new(HashMap::new()) }
    }

    fn cert_file(&self, alias: &str) -> Result<PathBuf, String> {
        if !alias.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) {
            return Err("недопустимый псевдоним".into());
        }
        Ok(self.certs.join(format!("{alias}.pem")))
    }

    pub fn set_cert(&self, alias: &str, pem: &str) -> Result<(), String> {
        std::fs::create_dir_all(&self.certs).map_err(|e| e.to_string())?;
        std::fs::write(self.cert_file(alias)?, pem).map_err(|e| e.to_string())?;
        self.clients.lock().unwrap().remove(alias);
        Ok(())
    }

    fn client(&self, alias: Option<&str>) -> Result<reqwest::Client, String> {
        let key = alias.unwrap_or("").to_string();
        if let Some(c) = self.clients.lock().unwrap().get(&key) {
            return Ok(c.clone());
        }
        let b = rustls::ClientConfig::builder_with_provider(provider()).with_safe_default_protocol_versions().map_err(|e| e.to_string())?
            .with_root_certificates(roots());
        let cfg = match alias {
            None => b.with_no_client_auth(),
            Some(a) => {
                let pem = std::fs::read(self.cert_file(a)?).map_err(|_| "сертификата устройства ещё нет".to_string())?;
                let chain: Vec<CertificateDer<'static>> = rustls_pemfile::certs(&mut pem.as_slice()).collect::<Result<_, _>>().map_err(|e| e.to_string())?;
                if chain.is_empty() {
                    return Err("сертификат устройства пуст".into());
                }
                let ck = CertifiedKey::new(chain, Arc::new(TpmKey(a.to_string())));
                b.with_client_cert_resolver(Arc::new(Resolver(Arc::new(ck))))
            }
        };
        let c = reqwest::Client::builder().use_preconfigured_tls(cfg).connect_timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
        self.clients.lock().unwrap().insert(key, c.clone());
        Ok(c)
    }

    fn build(&self, r: &Req) -> Result<reqwest::RequestBuilder, String> {
        if !r.url.starts_with("https://") {
            return Err("только https".into());
        }
        let m = reqwest::Method::from_bytes(r.method.as_bytes()).map_err(|_| "метод")?;
        let mut b = self.client(r.cert_alias.as_deref())?.request(m, &r.url);
        for (k, v) in &r.headers {
            b = b.header(k, v);
        }
        if let Some(body) = &r.body {
            b = b.body(body.clone());
        }
        Ok(b)
    }

    pub async fn request(&self, r: Req) -> Result<Resp, String> {
        let b = self.build(&r)?.timeout(Duration::from_millis(r.timeout_ms.unwrap_or(30_000)));
        let res = b.send().await.map_err(|e| format!("сеть: {e}"))?;
        let status = res.status().as_u16();
        Ok(Resp { status, body: res.text().await.map_err(|e| format!("сеть: {e}"))? })
    }

    pub fn open_stream(self: &Arc<Self>, app: AppHandle, id: String, r: Req) {
        let me = self.clone();
        let sid = id.clone();
        let task = tokio::spawn(async move {
            let emit = |v: serde_json::Value| {
                let _ = app.emit("fd-stream", v);
            };
            let res = match me.build(&r) {
                Ok(b) => b.send().await.map_err(|e| format!("сеть: {e}")),
                Err(e) => Err(e),
            };
            let res = match res {
                Ok(r) => r,
                Err(e) => {
                    emit(serde_json::json!({"id": sid, "kind": "end", "error": e}));
                    return;
                }
            };
            let status = res.status().as_u16();
            emit(serde_json::json!({"id": sid, "kind": "open", "status": status}));
            let mut body = res.bytes_stream();
            let mut carry: Vec<u8> = Vec::new();
            while let Some(chunk) = body.next().await {
                match chunk {
                    Ok(b) => {
                        carry.extend_from_slice(&b);
                        // отдаём только целые символы UTF-8; хвост ждёт следующий кусок
                        let cut = match std::str::from_utf8(&carry) {
                            Ok(_) => carry.len(),
                            Err(e) => e.valid_up_to(),
                        };
                        if cut > 0 {
                            let text = String::from_utf8_lossy(&carry[..cut]).into_owned();
                            carry.drain(..cut);
                            emit(serde_json::json!({"id": sid, "kind": "chunk", "text": text}));
                        }
                    }
                    Err(e) => {
                        emit(serde_json::json!({"id": sid, "kind": "end", "status": status, "error": format!("сеть: {e}")}));
                        me.streams.lock().unwrap().remove(&sid);
                        return;
                    }
                }
            }
            emit(serde_json::json!({"id": sid, "kind": "end", "status": status}));
            me.streams.lock().unwrap().remove(&sid);
        });
        self.streams.lock().unwrap().insert(id, task.abort_handle());
    }

    pub fn close_stream(&self, id: &str) {
        if let Some(h) = self.streams.lock().unwrap().remove(id) {
            h.abort();
        }
    }
}
