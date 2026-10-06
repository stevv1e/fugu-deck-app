/** Юнит-тесты ядра протокола. Запуск: npm test (Node + tsx). Кросс-проверка с Python-сервером через python3. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";

import { base32, b64u, fromUtf8, unb64, utf8 } from "../src/core/bytes";
import { canonicalString } from "../src/core/canonical";
import {
  argsHash,
  derToRaw,
  fingerprintOf,
  jwkFromPoint,
  jwkThumbprint,
  rawToDer,
  softKeygen,
  softSign,
  verifyEs256,
} from "../src/core/crypto";
import { buildCsr } from "../src/core/csr";
import { dpopProof } from "../src/core/dpop";
import { formatFp, inviteLink, normalizeServerUrl, parseInvite } from "../src/core/invite";
import { makeKey } from "../src/core/keys";
import { SseParser } from "../src/core/sse";
import { memoryStore, softwareProvider } from "../src/core/softkeys";
import { applyEvent, type Item } from "../src/core/timeline";

const BACKEND = path.resolve(__dirname, "../../backend");

function py(code: string, input = ""): string {
  const r = spawnSync("python3", ["-c", code], { cwd: BACKEND, input, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
}

test("base64url, base32, utf8", () => {
  const b = Uint8Array.from([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual(unb64(b64u(b)), b);
  assert.equal(b64u(utf8("ёжик 🦔")), Buffer.from("ёжик 🦔").toString("base64url"));
  assert.equal(fromUtf8(utf8("ёжик 🦔")), "ёжик 🦔");
  assert.equal(base32(utf8("foobar")), "MZXW6YTBOI");
  assert.equal(base32(utf8("f")), "MY");
});

test("канонический JSON совпадает с сервером (Python) байт в байт", () => {
  const samples = [
    '{"b":[1.0,2,{"z":0.5,"a":"é\\n"}],"a":null,"я":true,"Z":1e-7}',
    '{"files":[{"path":"a b/ц.py","content":"print(\\"hi\\")\\n\\t\\u0001"}],"n":12345678901234567890,"f":-0.0,"big":1e21,"x":1e16}',
    '{"emoji":"🦔 \\u2028","nested":{"k2":[true,false,null],"k1":{}},"":"пусто","ratio":0.1,"neg":-2.50}',
    '[1.5e-7, 100.0, 0.000001, 123456789.125, "\\u007f"]',
  ];
  for (const s of samples) {
    const out = py(
      "import json,sys\nfrom app.devices import canonical\nv=json.loads(sys.stdin.read())\n" +
        "print(json.dumps({'wire':json.dumps(v,ensure_ascii=False,default=str),'canon':canonical(v).decode()},ensure_ascii=False))",
      s,
    );
    const { wire, canon } = JSON.parse(out);
    // телефон получает JSON от сервера (wire), разбирает и канонизирует сам
    assert.equal(canonicalString(JSON.parse(wire)), canon, s);
  }
});

test("хэш аргументов совпадает с сервером", () => {
  const args = { provider: "github", repo: "me/demo", files: [{ path: "hello.py", content: "print('hi')\n" }], weight: 1.0 };
  const server = py(
    "import json,sys\nfrom app.devices import args_hash\nprint(args_hash(json.loads(sys.stdin.read())))",
    JSON.stringify(args),
  ).trim();
  assert.equal(argsHash(args), server);
});

test("отпечаток и подпись Ed25519 как на сервере", () => {
  const out = py(
    "from cryptography.hazmat.primitives.asymmetric import ed25519\nfrom cryptography.hazmat.primitives import serialization as s\n" +
      "from app.devices import b64u, base32_fp, canonical\nimport json\nk=ed25519.Ed25519PrivateKey.generate()\n" +
      "raw=k.public_key().public_bytes(s.Encoding.Raw,s.PublicFormat.Raw)\nobj={'type':'enrolled','user':'Миша','n':2}\n" +
      "print(json.dumps({'key':b64u(raw),'fp':base32_fp(raw),'sig':b64u(k.sign(canonical(obj))),'obj':obj}))",
  );
  const v = JSON.parse(out);
  assert.equal(fingerprintOf(v.key), v.fp);
  const { verifyServerSig } = require("../src/core/crypto");
  assert.equal(verifyServerSig(v.key, v.obj, v.sig), true);
  assert.equal(verifyServerSig(v.key, { ...v.obj, n: 3 }, v.sig), false);
});

test("ES256: r‖s ⇄ DER, проверка, jkt как в RFC 7638", () => {
  const { secret, point } = softKeygen();
  const jwk = jwkFromPoint(point);
  const data = utf8("данные");
  const raw = softSign(secret, data);
  assert.equal(raw.length, 64);
  assert.deepEqual(derToRaw(rawToDer(raw)), raw);
  assert.ok(verifyEs256(jwk, data, raw));
  assert.ok(!verifyEs256(jwk, utf8("другие"), raw));
  // вектор из RFC 7638 §3.1 — для RSA; для EC проверяем формулу явно
  assert.equal(jwkThumbprint(jwk), b64u(require("node:crypto").createHash("sha256").update(`{"crv":"P-256","kty":"EC","x":"${jwk.x}","y":"${jwk.y}"}`).digest()));
});

test("DPoP-доказательство: заголовок, поля, подпись", async () => {
  const { secret, point } = softKeygen();
  const key = makeKey(jwkFromPoint(point), async (d) => softSign(secret, d));
  const p = await dpopProof({ key, method: "get", url: "https://h.example/api/x?y=1#z", accessToken: "AT", now: 1700000000.7 });
  const [h, pl, sig] = p.split(".");
  const hdr = JSON.parse(fromUtf8(unb64(h)));
  const body = JSON.parse(fromUtf8(unb64(pl)));
  assert.deepEqual(hdr, { typ: "dpop+jwt", alg: "ES256", jwk: key.jwk });
  assert.equal(body.htm, "GET");
  assert.equal(body.htu, "https://h.example/api/x");
  assert.equal(body.iat, 1700000000);
  assert.equal(body.ath, b64u(require("node:crypto").createHash("sha256").update("AT").digest()));
  assert.ok(verifyEs256(key.jwk, utf8(h + "." + pl), unb64(sig)));
});

test("CSR читается и проверяется Python cryptography", async () => {
  const { secret, point } = softKeygen();
  const key = makeKey(jwkFromPoint(point), async (d) => softSign(secret, d));
  const pem = await buildCsr(key, "fugu-deck device");
  const out = py(
    "import sys\nfrom cryptography import x509\nc=x509.load_pem_x509_csr(sys.stdin.read().encode())\n" +
      "n=c.public_key().public_numbers()\nprint(c.is_signature_valid, c.subject.rfc4514_string(), n.x)",
    pem,
  ).trim();
  const x = BigInt("0x" + Buffer.from(unb64(key.jwk.x)).toString("hex")).toString();
  assert.equal(out, `True CN=fugu-deck device ${x}`);
});

test("приглашения и адреса", () => {
  const fp = "ABCD".repeat(13);
  const inv = parseInvite(inviteLink("https://deck.example.com:8443/", fp, "Мой сервер"));
  assert.deepEqual(inv, { url: "https://deck.example.com:8443", fp, name: "Мой сервер", source: "qr" });
  assert.equal(parseInvite("fugudeck://add?url=https%3A%2F%2Fa.b&fp=" + fp.toLowerCase() + "&name=X+Y").name, "X Y");
  assert.equal(normalizeServerUrl("Deck.Example.com"), "https://deck.example.com");
  assert.equal(normalizeServerUrl("https://deck.example.com:443/sub/"), "https://deck.example.com/sub");
  assert.equal(normalizeServerUrl("http://192.168.1.5:8000"), "http://192.168.1.5:8000");
  assert.throws(() => normalizeServerUrl("http://deck.example.com"), /локальной сети/);
  assert.throws(() => parseInvite("fugudeck://add?url=https://a.b&fp=SHORT"), /повреждён/);
  assert.throws(() => normalizeServerUrl("не адрес"), /адрес/);
  assert.equal(formatFp(fp).split(" ").length, 13);
});

test("SSE: куски, комментарии, событие end", () => {
  const p = new SseParser();
  assert.deepEqual(p.feed("retry: 2000\n\nid: 1\ndata: {\"a\""), []);
  assert.deepEqual(p.feed(":1}\n\n: ping\n\nevent: end\r\ndata: {}\r\n\r\n"), [
    { id: "1", event: "message", data: '{"a":1}' },
    { id: undefined, event: "end", data: "{}" },
  ]);
});

test("программные ключи: создать, загрузить, подписать, биометрия на подтверждение", async () => {
  const store = memoryStore();
  const asked: string[] = [];
  const prov = softwareProvider({ store, gate: async (r) => void asked.push(r), storeAuth: false, biometry: true });
  const keys = await prov.create("fd.test");
  assert.notEqual(keys.session.jkt, keys.confirm.jkt);
  const again = await prov.load("fd.test");
  assert.equal(again!.session.jkt, keys.session.jkt);
  const sig = await again!.confirm.sign(utf8("x"), "Разрешить коммит");
  assert.ok(verifyEs256(keys.confirm.jwk, utf8("x"), sig));
  assert.deepEqual(asked, ["Разрешить коммит"]);
  await again!.session.sign(utf8("y"));
  assert.equal(asked.length, 1, "ключ сессии биометрию не спрашивает");
  await prov.remove("fd.test");
  assert.equal(await prov.load("fd.test"), null);
});

test("лента: запрос подтверждения хранит исходное событие", () => {
  let items: Item[] = [];
  items = applyEvent(items, { seq: 0, type: "text", delta: "Делаю " });
  items = applyEvent(items, {
    seq: 1, type: "approval_request", approval_id: "a1", call_id: "c1", name: "commit_files", args: { x: 1 }, risk: "write",
  });
  const t = items[1] as Extract<Item, { kind: "tool" }>;
  assert.equal(t.status, "pending");
  assert.equal(t.approval?.approval_id, "a1");
  items = applyEvent(items, { seq: 2, type: "approval_resolved", approval_id: "a1", call_id: "c1", approved: true });
  assert.equal((items[1] as any).status, "running");
  assert.equal((items[1] as any).approval, undefined);
});
