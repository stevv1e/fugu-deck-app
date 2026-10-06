package expo.modules.fdsecure

import android.content.Context
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import java.io.ByteArrayInputStream
import java.io.IOException
import java.math.BigInteger
import java.net.Socket
import java.security.KeyFactory
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.Principal
import java.security.PrivateKey
import java.security.ProviderException
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager

// Ключи устройства в Android Keystore (StrongBox, если есть, иначе TEE) и транспорт с mTLS.
//  • ключ сессии — без проверки пользователя: DPoP, CSR, TLS-рукопожатие;
//  • ключ подтверждения — BiometricPrompt (класс STRONG) на КАЖДУЮ подпись, CryptoObject привязан к операции,
//    ключ становится непригодным при добавлении нового отпечатка/лица.
//  • аттестация ключа (Android Key Attestation) — цепочка сертификатов с вызовом сервера внутри;
//    проверяется на сервере офлайн по корням Google, без Play Integrity.

class HttpReq : Record {
  @Field var url: String = ""
  @Field var method: String = "GET"
  @Field var headers: Map<String, String> = emptyMap()
  @Field var body: String? = null
  @Field var certAlias: String? = null
  @Field var timeoutMs: Double = 30000.0
}

class FdSecureModule : Module() {
  private val streams = ConcurrentHashMap<String, Call>()
  private val clients = ConcurrentHashMap<String, OkHttpClient>()

  private val context: Context
    get() = appContext.reactContext ?: throw IllegalStateException("Нет контекста приложения")

  private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

  override fun definition() = ModuleDefinition {
    Name("FdSecure")
    Events("onStreamOpen", "onStreamChunk", "onStreamEnd")

    Function("capabilities") {
      val bio = BiometricManager.from(context).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG) ==
        BiometricManager.BIOMETRIC_SUCCESS
      val strongbox = Build.VERSION.SDK_INT >= 28 &&
        context.packageManager.hasSystemFeature("android.hardware.strongbox_keystore")
      mapOf("platform" to "android", "hardware" to true, "strongbox" to strongbox, "biometry" to bio, "mtls" to true, "appAttest" to false)
    }

    AsyncFunction("generateKey") { alias: String, requireBiometry: Boolean, challenge: String?, promise: Promise ->
      try {
        val ks = keyStore()
        if (ks.containsAlias(alias)) ks.deleteEntry(alias)
        val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
        val wantStrongBox = Build.VERSION.SDK_INT >= 28 &&
          context.packageManager.hasSystemFeature("android.hardware.strongbox_keystore")
        try {
          kpg.initialize(spec(alias, requireBiometry, challenge, wantStrongBox))
          kpg.generateKeyPair()
        } catch (e: ProviderException) {
          if (!wantStrongBox) throw e
          kpg.initialize(spec(alias, requireBiometry, challenge, false)) // StrongBox недоступен — TEE
          kpg.generateKeyPair()
        }
        val chain = ks.getCertificateChain(alias)?.map { Base64.encodeToString(it.encoded, Base64.NO_WRAP) }
        promise.resolve(
          mapOf(
            "publicKey" to point(ks, alias),
            "storage" to storage(ks, alias),
            "attestation" to if (challenge != null && chain != null)
              mapOf("format" to "android-key", "chain" to chain) else null
          )
        )
      } catch (e: Exception) {
        promise.reject("E_KEYGEN", "Не удалось создать ключ: ${e.message}", e)
      }
    }

    AsyncFunction("publicKey") { alias: String, promise: Promise ->
      val ks = keyStore()
      if (!ks.containsAlias(alias)) {
        promise.resolve(null)
      } else {
        promise.resolve(mapOf("publicKey" to point(ks, alias), "storage" to storage(ks, alias)))
      }
    }

    AsyncFunction("sign") { alias: String, data: String, prompt: String?, promise: Promise ->
      try {
        val ks = keyStore()
        val key = ks.getKey(alias, null) as? PrivateKey
        if (key == null) {
          promise.reject("E_NO_KEY", "Ключ не найден — зарегистрируйте устройство заново", null)
          return@AsyncFunction
        }
        val bytes = Base64.decode(data, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
        val sig = Signature.getInstance("SHA256withECDSA")
        try {
          sig.initSign(key)
        } catch (e: KeyPermanentlyInvalidatedException) {
          promise.reject("E_INVALIDATED", "Биометрия изменилась — ключ подтверждения больше не действует. Зарегистрируйте устройство заново.", e)
          return@AsyncFunction
        }
        if (!needsAuth(key)) {
          sig.update(bytes)
          promise.resolve(Base64.encodeToString(sig.sign(), Base64.NO_WRAP))
          return@AsyncFunction
        }
        val activity = appContext.currentActivity as? FragmentActivity
        if (activity == null) {
          promise.reject("E_UI", "Нет активного экрана для биометрии", null)
          return@AsyncFunction
        }
        activity.runOnUiThread {
          val cb = object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
              try {
                val s = result.cryptoObject?.signature ?: throw IllegalStateException("нет подписи")
                s.update(bytes)
                promise.resolve(Base64.encodeToString(s.sign(), Base64.NO_WRAP))
              } catch (e: Exception) {
                promise.reject("E_SIGN", "Подпись не удалась: ${e.message}", e)
              }
            }

            override fun onAuthenticationError(code: Int, msg: CharSequence) {
              val cancelled = code == BiometricPrompt.ERROR_USER_CANCELED ||
                code == BiometricPrompt.ERROR_NEGATIVE_BUTTON || code == BiometricPrompt.ERROR_CANCELED
              promise.reject(if (cancelled) "E_CANCELLED" else "E_AUTH", msg.toString(), null)
            }
          }
          val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(prompt ?: "Подтверждение")
            .setSubtitle("Fugu Deck")
            .setNegativeButtonText("Отмена")
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setConfirmationRequired(true)
            .build()
          BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), cb)
            .authenticate(info, BiometricPrompt.CryptoObject(sig))
        }
      } catch (e: Exception) {
        promise.reject("E_SIGN", "Подпись не удалась: ${e.message}", e)
      }
    }

    AsyncFunction("deleteKey") { alias: String ->
      val ks = keyStore()
      if (ks.containsAlias(alias)) ks.deleteEntry(alias)
      prefs().edit().remove("cert.$alias").apply()
      forget(alias)
    }

    // ---------------------------------------------------------------- mTLS
    AsyncFunction("setClientCertificate") { alias: String, certPem: String ->
      val cert = parseCert(certPem)
      val pub = cert.publicKey as ECPublicKey
      val ks = keyStore()
      val mine = ks.getCertificate(alias)?.publicKey as? ECPublicKey
        ?: throw IllegalStateException("Ключ сессии не найден")
      if (pub.w != mine.w) throw IllegalArgumentException("Сертификат не подходит к ключу сессии")
      prefs().edit().putString("cert.$alias", certPem).apply()
      forget(alias)
      true
    }

    AsyncFunction("request") { req: HttpReq, promise: Promise ->
      client(req.certAlias).newCall(build(req)).enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          promise.reject("E_NETWORK", e.message ?: "Сеть недоступна", e)
        }

        override fun onResponse(call: Call, response: Response) {
          response.use { promise.resolve(mapOf("status" to it.code, "body" to (it.body?.string() ?: ""))) }
        }
      })
    }

    Function("openStream") { id: String, req: HttpReq ->
      val call = client(req.certAlias, stream = true).newCall(build(req))
      streams[id] = call
      call.enqueue(object : Callback {
        override fun onFailure(call: Call, e: IOException) {
          streams.remove(id)
          sendEvent("onStreamEnd", mapOf("id" to id, "status" to 0, "error" to if (call.isCanceled()) null else e.message))
        }

        override fun onResponse(call: Call, response: Response) {
          sendEvent("onStreamOpen", mapOf("id" to id, "status" to response.code))
          try {
            response.body?.charStream()?.use { r ->
              val buf = CharArray(4096)
              while (true) {
                val n = r.read(buf)
                if (n < 0) break
                if (n > 0) sendEvent("onStreamChunk", mapOf("id" to id, "text" to String(buf, 0, n)))
              }
            }
            sendEvent("onStreamEnd", mapOf("id" to id, "status" to response.code))
          } catch (e: IOException) {
            sendEvent("onStreamEnd", mapOf("id" to id, "status" to response.code, "error" to if (call.isCanceled()) null else e.message))
          } finally {
            streams.remove(id)
            response.close()
          }
        }
      })
    }

    Function("closeStream") { id: String ->
      streams.remove(id)?.cancel()
    }
  }

  // ------------------------------------------------------------------ ключи
  private fun spec(alias: String, requireBiometry: Boolean, challenge: String?, strongBox: Boolean): KeyGenParameterSpec {
    val b = KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
      .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
      .setDigests(KeyProperties.DIGEST_SHA256)
    if (challenge != null) {
      b.setAttestationChallenge(Base64.decode(challenge, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
    }
    if (requireBiometry) {
      b.setUserAuthenticationRequired(true)
      if (Build.VERSION.SDK_INT >= 30) {
        b.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
      } else {
        @Suppress("DEPRECATION")
        b.setUserAuthenticationValidityDurationSeconds(-1)
      }
      b.setInvalidatedByBiometricEnrollment(true)
    }
    if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true)
    return b.build()
  }

  private fun keyInfo(ks: KeyStore, alias: String): KeyInfo {
    val key = ks.getKey(alias, null) as PrivateKey
    return KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java)
  }

  private fun needsAuth(key: PrivateKey): Boolean =
    KeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java).isUserAuthenticationRequired

  private fun storage(ks: KeyStore, alias: String): String {
    val info = keyInfo(ks, alias)
    return if (Build.VERSION.SDK_INT >= 31) {
      when (info.securityLevel) {
        KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
        KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
        else -> "software"
      }
    } else {
      @Suppress("DEPRECATION")
      if (info.isInsideSecureHardware) "tee" else "software"
    }
  }

  private fun point(ks: KeyStore, alias: String): String {
    val pub = ks.getCertificate(alias).publicKey as ECPublicKey
    val out = ByteArray(65)
    out[0] = 4
    fixed(pub.w.affineX).copyInto(out, 1)
    fixed(pub.w.affineY).copyInto(out, 33)
    return Base64.encodeToString(out, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING)
  }

  private fun fixed(n: BigInteger): ByteArray {
    val b = n.toByteArray()
    return when {
      b.size == 32 -> b
      b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
      else -> ByteArray(32 - b.size) + b
    }
  }

  // ------------------------------------------------------------------ транспорт
  private fun forget(alias: String) {
    clients.remove("r:$alias")
    clients.remove("s:$alias")
  }

  private fun prefs() = context.getSharedPreferences("fd-secure", Context.MODE_PRIVATE)

  private fun parseCert(pem: String): X509Certificate =
    CertificateFactory.getInstance("X.509").generateCertificate(ByteArrayInputStream(pem.toByteArray())) as X509Certificate

  private fun build(req: HttpReq): Request {
    val b = Request.Builder().url(req.url)
    req.headers.forEach { (k, v) -> b.header(k, v) }
    val body = req.body?.toRequestBody((req.headers["content-type"] ?: "application/json").toMediaTypeOrNull())
    b.method(req.method.uppercase(), if (req.method.uppercase() == "GET") null else body ?: "".toRequestBody(null))
    return b.build()
  }

  private fun client(alias: String?, stream: Boolean = false): OkHttpClient {
    val key = (if (stream) "s:" else "r:") + (alias ?: "")
    return clients.getOrPut(key) {
      val b = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(if (stream) 0L else 60L, TimeUnit.SECONDS)
      val pem = alias?.let { prefs().getString("cert.$it", null) }
      if (alias != null && pem != null) {
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(null as KeyStore?) }
        val tm = tmf.trustManagers.first { it is X509TrustManager } as X509TrustManager
        val ctx = SSLContext.getInstance("TLS")
        ctx.init(arrayOf(DeviceKeyManager(alias, arrayOf(parseCert(pem)))), arrayOf(tm), null)
        b.sslSocketFactory(ctx.socketFactory, tm)
      }
      b.build()
    }
  }

  /** Отдаёт TLS ключ сессии из Keystore и сертификат устройства. Закрытый ключ остаётся в чипе. */
  private class DeviceKeyManager(private val alias: String, private val chain: Array<X509Certificate>) : X509ExtendedKeyManager() {
    override fun chooseClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?) = alias
    override fun chooseEngineClientAlias(keyType: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?) = alias
    override fun getClientAliases(keyType: String?, issuers: Array<out Principal>?) = arrayOf(alias)
    override fun getCertificateChain(a: String?) = chain
    override fun getPrivateKey(a: String?): PrivateKey =
      KeyStore.getInstance("AndroidKeyStore").apply { load(null) }.getKey(alias, null) as PrivateKey
    override fun getServerAliases(keyType: String?, issuers: Array<out Principal>?): Array<String>? = null
    override fun chooseServerAlias(keyType: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
  }
}
