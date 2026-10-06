import CryptoKit
import DeviceCheck
import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security

// Ключи устройства в Secure Enclave и транспорт с клиентским сертификатом (mTLS).
// Закрытые ключи не покидают чип: наружу — только открытый ключ и подписи.
//  • ключ сессии: .privateKeyUsage — подписывает DPoP и CSR, работает без биометрии;
//  • ключ подтверждения: .privateKeyUsage + .biometryCurrentSet — Face ID / Touch ID на КАЖДУЮ подпись,
//    при изменении биометрии ключ становится непригодным (нужна новая регистрация).

struct HttpReq: Record {
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: [String: String] = [:]
  @Field var body: String?
  @Field var certAlias: String?
  @Field var timeoutMs: Double = 30000
}

public class FdSecureModule: Module {
  private var streams: [String: URLSessionDataTask] = [:]
  private let lock = NSLock()
  private lazy var tls = TlsDelegate(module: self)

  public func definition() -> ModuleDefinition {
    Name("FdSecure")
    Events("onStreamOpen", "onStreamChunk", "onStreamEnd")

    Function("capabilities") { () -> [String: Any] in
      let ctx = LAContext()
      var err: NSError?
      let bio = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &err)
      return [
        "platform": "ios",
        "hardware": SecureEnclave.isAvailable,
        "strongbox": false,
        "biometry": bio,
        "mtls": true,
        "appAttest": DCAppAttestService.shared.isSupported,
      ]
    }

    AsyncFunction("generateKey") { (alias: String, requireBiometry: Bool, _: String?, promise: Promise) in
      Keys.delete(alias)
      let useSE = SecureEnclave.isAvailable
      var flags: SecAccessControlCreateFlags = []
      if useSE { flags.insert(.privateKeyUsage) }
      if requireBiometry { flags.insert(.biometryCurrentSet) }
      var error: Unmanaged<CFError>?
      guard let access = SecAccessControlCreateWithFlags(
        kCFAllocatorDefault, kSecAttrAccessibleWhenUnlockedThisDeviceOnly, flags, &error)
      else {
        promise.reject("E_KEYGEN", "Не удалось задать доступ к ключу: \(Keys.describe(error))")
        return
      }
      var attrs: [String: Any] = [
        kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
        kSecAttrKeySizeInBits as String: 256,
        kSecPrivateKeyAttrs as String: [
          kSecAttrIsPermanent as String: true,
          kSecAttrApplicationTag as String: Keys.tag(alias),
          kSecAttrLabel as String: alias,
          kSecAttrAccessControl as String: access,
        ] as [String: Any],
      ]
      if useSE { attrs[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave }
      guard let priv = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
        promise.reject("E_KEYGEN", "Не удалось создать ключ: \(Keys.describe(error))")
        return
      }
      guard let point = Keys.publicPoint(priv) else {
        promise.reject("E_KEYGEN", "Не удалось прочитать открытый ключ")
        return
      }
      promise.resolve([
        "publicKey": B64.url(point),
        "storage": useSE ? "secure_enclave" : "software",
        "attestation": NSNull(),
      ])
    }

    AsyncFunction("publicKey") { (alias: String, promise: Promise) in
      guard let key = Keys.find(alias, prompt: nil), let point = Keys.publicPoint(key) else {
        promise.resolve(nil)
        return
      }
      let attrs = SecKeyCopyAttributes(key) as? [String: Any]
      let token = attrs?[kSecAttrTokenID as String] as? String
      promise.resolve([
        "publicKey": B64.url(point),
        "storage": token == (kSecAttrTokenIDSecureEnclave as String) ? "secure_enclave" : "software",
      ])
    }

    AsyncFunction("sign") { (alias: String, data: String, prompt: String?, promise: Promise) in
      DispatchQueue.global(qos: .userInitiated).async {
        guard let bytes = B64.decode(data) else {
          promise.reject("E_ARG", "Данные для подписи не в base64")
          return
        }
        guard let key = Keys.find(alias, prompt: prompt) else {
          promise.reject("E_NO_KEY", "Ключ не найден — зарегистрируйте устройство заново")
          return
        }
        var error: Unmanaged<CFError>?
        guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, bytes as CFData, &error) as Data?
        else {
          let code = error.map { CFErrorGetCode($0.takeUnretainedValue()) } ?? 0
          if code == Int(errSecUserCanceled) || code == LAError.userCancel.rawValue || code == LAError.appCancel.rawValue {
            promise.reject("E_CANCELLED", "Подтверждение отменено")
          } else {
            promise.reject("E_SIGN", "Подпись не удалась: \(Keys.describe(error))")
          }
          return
        }
        promise.resolve(sig.base64EncodedString())  // DER; в r‖s переводит JS
      }
    }

    AsyncFunction("deleteKey") { (alias: String) in
      Keys.delete(alias)
      Keys.deleteCert(alias)
    }

    // App Attest: подтверждение, что запрос идёт из настоящего приложения на настоящем iPhone.
    // clientDataHash = SHA-256(вызов сервера ‖ jkt ключей). Проверка — на сервере (корень Apple, офлайн).
    AsyncFunction("appAttest") { (clientDataHash: String, promise: Promise) in
      let svc = DCAppAttestService.shared
      guard svc.isSupported, let hash = B64.decode(clientDataHash) else {
        promise.resolve(nil)
        return
      }
      svc.generateKey { keyId, err in
        guard let keyId = keyId, err == nil else {
          promise.resolve(nil)
          return
        }
        svc.attestKey(keyId, clientDataHash: hash) { obj, err in
          guard let obj = obj, err == nil else {
            promise.resolve(nil)
            return
          }
          promise.resolve(["format": "apple-app-attest", "keyId": keyId, "attestation": obj.base64EncodedString()])
        }
      }
    }

    // ---------------------------------------------------------------- mTLS
    AsyncFunction("setClientCertificate") { (alias: String, certPem: String, promise: Promise) in
      guard let der = Pem.der(certPem), let cert = SecCertificateCreateWithData(nil, der as CFData) else {
        promise.reject("E_CERT", "Сертификат не читается")
        return
      }
      Keys.deleteCert(alias)
      let add: [String: Any] = [
        kSecClass as String: kSecClassCertificate,
        kSecValueRef as String: cert,
        kSecAttrLabel as String: "fd-cert-" + alias,
      ]
      let st = SecItemAdd(add as CFDictionary, nil)
      if st != errSecSuccess && st != errSecDuplicateItem {
        promise.reject("E_CERT", "Не удалось сохранить сертификат (\(st))")
        return
      }
      guard Keys.identity(alias) != nil else {
        promise.reject("E_CERT", "Сертификат не подходит к ключу сессии")
        return
      }
      promise.resolve(true)
    }

    AsyncFunction("request") { (req: HttpReq, promise: Promise) in
      guard let r = self.urlRequest(req) else {
        promise.reject("E_ARG", "Неверный адрес")
        return
      }
      let task = self.tls.session(for: req.certAlias).dataTask(with: r) { data, resp, err in
        if let err = err {
          promise.reject("E_NETWORK", err.localizedDescription)
          return
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        promise.resolve(["status": status, "body": String(decoding: data ?? Data(), as: UTF8.self)])
      }
      task.resume()
    }

    Function("openStream") { (id: String, req: HttpReq) in
      guard let r = self.urlRequest(req) else {
        self.sendEvent("onStreamEnd", ["id": id, "error": "Неверный адрес"])
        return
      }
      let task = self.tls.streamSession(for: req.certAlias).dataTask(with: r)
      self.tls.register(task: task, id: id)
      self.lock.lock()
      self.streams[id] = task
      self.lock.unlock()
      task.resume()
    }

    Function("closeStream") { (id: String) in
      self.lock.lock()
      let t = self.streams.removeValue(forKey: id)
      self.lock.unlock()
      t?.cancel()
    }
  }

  func streamFinished(_ id: String) {
    lock.lock()
    streams.removeValue(forKey: id)
    lock.unlock()
  }

  func emit(_ name: String, _ body: [String: Any]) {
    sendEvent(name, body)
  }

  private func urlRequest(_ req: HttpReq) -> URLRequest? {
    guard let url = URL(string: req.url) else { return nil }
    var r = URLRequest(url: url, timeoutInterval: req.timeoutMs / 1000)
    r.httpMethod = req.method
    for (k, v) in req.headers { r.setValue(v, forHTTPHeaderField: k) }
    if let b = req.body { r.httpBody = b.data(using: .utf8) }
    r.cachePolicy = .reloadIgnoringLocalCacheData
    return r
  }
}

// ------------------------------------------------------------------ ключи
enum Keys {
  static func tag(_ alias: String) -> Data { ("fd-key-" + alias).data(using: .utf8)! }

  static func find(_ alias: String, prompt: String?) -> SecKey? {
    var q: [String: Any] = [
      kSecClass as String: kSecClassKey,
      kSecAttrApplicationTag as String: tag(alias),
      kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef as String: true,
    ]
    if let p = prompt {
      let ctx = LAContext()
      ctx.localizedReason = p
      q[kSecUseAuthenticationContext as String] = ctx
    }
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let ref = out else { return nil }
    return (ref as! SecKey)
  }

  static func publicPoint(_ priv: SecKey) -> Data? {
    guard let pub = SecKeyCopyPublicKey(priv) else { return nil }
    var error: Unmanaged<CFError>?
    return SecKeyCopyExternalRepresentation(pub, &error) as Data?  // 0x04‖X‖Y
  }

  static func delete(_ alias: String) {
    let q: [String: Any] = [kSecClass as String: kSecClassKey, kSecAttrApplicationTag as String: tag(alias)]
    SecItemDelete(q as CFDictionary)
  }

  static func deleteCert(_ alias: String) {
    let q: [String: Any] = [kSecClass as String: kSecClassCertificate, kSecAttrLabel as String: "fd-cert-" + alias]
    SecItemDelete(q as CFDictionary)
  }

  /// Связка «ключ сессии + сертификат» для TLS. Keychain сопоставляет их по хэшу открытого ключа.
  static func identity(_ alias: String) -> SecIdentity? {
    guard let key = find(alias, prompt: nil),
      let attrs = SecKeyCopyAttributes(key) as? [String: Any],
      let label = attrs[kSecAttrApplicationLabel as String] as? Data
    else { return nil }
    let q: [String: Any] = [
      kSecClass as String: kSecClassIdentity,
      kSecAttrApplicationLabel as String: label,
      kSecReturnRef as String: true,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let ref = out else { return nil }
    return (ref as! SecIdentity)
  }

  static func describe(_ e: Unmanaged<CFError>?) -> String {
    guard let e = e?.takeRetainedValue() else { return "неизвестная ошибка" }
    return (e as Error).localizedDescription
  }
}

enum B64 {
  static func url(_ d: Data) -> String {
    d.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  static func decode(_ s: String) -> Data? {
    var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
    while t.count % 4 != 0 { t += "=" }
    return Data(base64Encoded: t)
  }
}

enum Pem {
  static func der(_ pem: String) -> Data? {
    let body = pem.components(separatedBy: "\n").filter { !$0.hasPrefix("-----") }.joined()
    return Data(base64Encoded: body)
  }
}

// ------------------------------------------------------------------ TLS и потоки
final class TlsDelegate: NSObject, URLSessionDataDelegate {
  private weak var module: FdSecureModule?
  private var sessions: [String: URLSession] = [:]
  private var ids: [Int: String] = [:]
  private var pending: [Int: Data] = [:]
  private let lock = NSLock()

  init(module: FdSecureModule) { self.module = module }

  func session(for alias: String?) -> URLSession { make(alias, stream: false) }
  func streamSession(for alias: String?) -> URLSession { make(alias, stream: true) }

  private func make(_ alias: String?, stream: Bool) -> URLSession {
    let key = (stream ? "s:" : "r:") + (alias ?? "")
    lock.lock()
    defer { lock.unlock() }
    if let s = sessions[key] { return s }
    let cfg = URLSessionConfiguration.ephemeral
    cfg.httpAdditionalHeaders = ["X-Fd-Alias": alias ?? ""]
    if stream { cfg.timeoutIntervalForRequest = 3600 }
    let s = URLSession(configuration: cfg, delegate: self, delegateQueue: nil)
    sessions[key] = s
    return s
  }

  func register(task: URLSessionTask, id: String) {
    lock.lock()
    ids[task.taskIdentifier] = id
    lock.unlock()
  }

  private func id(of task: URLSessionTask) -> String? {
    lock.lock()
    defer { lock.unlock() }
    return ids[task.taskIdentifier]
  }

  func urlSession(
    _ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void
  ) {
    let alias = session.configuration.httpAdditionalHeaders?["X-Fd-Alias"] as? String ?? ""
    if challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodClientCertificate,
      !alias.isEmpty, let ident = Keys.identity(alias)
    {
      completionHandler(.useCredential, URLCredential(identity: ident, certificates: nil, persistence: .forSession))
      return
    }
    completionHandler(.performDefaultHandling, nil)
  }

  func urlSession(
    _ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
  ) {
    if let id = id(of: dataTask) {
      module?.emit("onStreamOpen", ["id": id, "status": (response as? HTTPURLResponse)?.statusCode ?? 0])
    }
    completionHandler(.allow)
  }

  func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
    guard let id = id(of: dataTask) else { return }
    lock.lock()
    var buf = (pending[dataTask.taskIdentifier] ?? Data()) + data
    // UTF-8 может разорваться посередине символа — отдаём только целые символы
    var cut = buf.count
    while cut > 0 && cut > buf.count - 4 {
      if String(data: buf.prefix(cut), encoding: .utf8) != nil { break }
      cut -= 1
    }
    let text = String(data: buf.prefix(cut), encoding: .utf8) ?? ""
    buf = buf.suffix(from: buf.startIndex + cut)
    pending[dataTask.taskIdentifier] = Data(buf)
    lock.unlock()
    if !text.isEmpty { module?.emit("onStreamChunk", ["id": id, "text": text]) }
  }

  func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    guard let id = id(of: task) else { return }
    lock.lock()
    ids.removeValue(forKey: task.taskIdentifier)
    pending.removeValue(forKey: task.taskIdentifier)
    lock.unlock()
    module?.streamFinished(id)
    var body: [String: Any] = ["id": id, "status": (task.response as? HTTPURLResponse)?.statusCode ?? 0]
    if let e = error as NSError?, e.code != NSURLErrorCancelled { body["error"] = e.localizedDescription }
    module?.emit("onStreamEnd", body)
  }
}
