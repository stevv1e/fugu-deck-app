/** Серверы для агента: что подписывается при добавлении сервера, выдаче прав и подтверждении команды. */
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateEnvelope } from "../src/core/actions";
import { jwkFromPoint, softKeygen, softSign } from "../src/core/crypto";
import { makeKey, type DeviceKeys } from "../src/core/keys";
import { ClusterSession } from "../src/core/session";
import { addServer, AGENT, serverProblem, setRights, setupScript, type ApiSession } from "../src/core/ssh";

function softKeys(): DeviceKeys {
  const s = softKeygen(), c = softKeygen();
  return {
    alias: "t", storage: "software", attestation: null,
    session: makeKey(jwkFromPoint(s.point), async (d) => softSign(s.secret, d)),
    confirm: makeKey(jwkFromPoint(c.point), async (d) => softSign(c.secret, d)),
  };
}
const payload = (signed: any) => JSON.parse(Buffer.from(signed.jws.split(".")[1], "base64url").toString());
const FP = "SHA256:" + "A".repeat(43);

test("сервер: негодное не доходит до подписи", () => {
  const ok = { id: "prod-1", host: "203.0.113.5", port: 22, user: "deck-agent", hostKey: FP };
  assert.equal(serverProblem(ok), null);
  assert.equal(serverProblem({ ...ok, host: "host.example.com" }), null);
  assert.match(serverProblem({ ...ok, user: "root" })!, /root/);
  assert.match(serverProblem({ ...ok, hostKey: "SHA256:short" })!, /Отпечаток/);
  assert.match(serverProblem({ ...ok, hostKey: "MD5:aa:bb" })!, /Отпечаток/);
  assert.match(serverProblem({ ...ok, port: 70000 })!, /Порт/);
  assert.match(serverProblem({ ...ok, host: "host name" })!, /Адрес/);
  assert.match(serverProblem({ ...ok, id: "прод" })!, /Имя/);
  assert.match(serverProblem({ ...ok, user: "Deck Agent" })!, /Пользователь/);
});

test("добавление сервера и права агента — подписанные действия для личного пространства", async () => {
  const keys = softKeys();
  const calls: { path: string; body: any }[] = [];
  const s: ApiSession = { request: async (_m, path, body) => { calls.push({ path, body }); return {} as any; } };
  await addServer(s, keys, "anna", { id: "prod-1", host: "Host.Example.com", port: 2222, user: "deck-agent", hostKey: FP });
  await setRights(s, keys, "anna", ["prod-2", "prod-1"], true);
  const [add, rights] = calls.map((c) => payload(c.body));
  assert.deepEqual(calls.map((c) => c.path), ["/v1/ssh/servers", "/v1/ssh/rights"]);
  assert.deepEqual([add.type, add.space, add.server, add.host, add.port, add.user, add.host_key], ["server_add", "u-anna", "prod-1", "host.example.com", 2222, "deck-agent", FP]);
  assert.deepEqual([rights.type, rights.space, rights.agent, rights.servers, rights.read_without_confirm, rights.limit_usd_month],
    ["agent_rights", "u-anna", AGENT, ["prod-1", "prod-2"], true, null]);
  validateEnvelope(add);
  validateEnvelope(rights);
  await assert.rejects(addServer(s, keys, "anna", { id: "x", host: "h", port: 22, user: "root", hostKey: FP }), /root/);
  assert.equal(calls.length, 2);
});

test("подтверждение команды: подписывается сама команда; для опасной — с введённым именем сервера", async () => {
  const keys = softKeys();
  const sess = new ClusterSession({ request: async () => ({ status: 200, text: "{}" }), stream: () => ({ close() {} }) } as any,
    { id: "cluster.x", url: "https://api.x/s/anna" } as any, keys,
    { deviceId: "d-0123456789abcdef", space: "u-anna", token: async () => ({ accessToken: "t", expiresIn: 300 }) });
  const w = payload(await sess.signCommand({ type: "ssh_write", agent: AGENT, server: "prod-1", command: "sudo systemctl restart app" }));
  assert.deepEqual([w.type, w.space, w.agent, w.server, w.command, "typed_server" in w], ["ssh_write", "u-anna", AGENT, "prod-1", "sudo systemctl restart app", false]);
  validateEnvelope(w);
  const d = payload(await sess.signCommand({ type: "ssh_danger", agent: AGENT, server: "prod-1", command: "rm -rf /var/lib/app" }, "prod-1"));
  assert.equal(d.typed_server, "prod-1");
  validateEnvelope(d);
  // имя сервера введено неверно — действие не проходит схему ещё на телефоне, биометрию не спрашиваем
  await assert.rejects(sess.signCommand({ type: "ssh_danger", agent: AGENT, server: "prod-1", command: "rm -rf /" }, "prod-2"), /имя сервера/i);
  await assert.rejects(sess.signCommand({ type: "ssh_danger", agent: AGENT, server: "prod-1", command: "rm -rf /" }), /typed_server|имя сервера/i);
  // сессия без пространства (сам api кластера) команды не подписывает
  const apiOnly = new ClusterSession({} as any, { id: "c", url: "https://api.x" } as any, keys, { deviceId: "d-0123456789abcdef", token: async () => ({ accessToken: "t", expiresIn: 300 }) });
  await assert.rejects(apiOnly.signCommand({ type: "ssh_write", agent: AGENT, server: "prod-1", command: "ls" }), /пространств/);
});

test("инструкция для сервера: ключ CA и имя входа агента этого пространства", () => {
  const sh = setupScript({ ca_public_key: "ssh-ed25519 AAAAC3 ca", principal_prefix: "deck-u-anna-" });
  assert.match(sh, /echo 'ssh-ed25519 AAAAC3 ca' \| sudo tee \/etc\/ssh\/deck_ca\.pub/);
  assert.match(sh, /printf '%s\\n' 'deck-u-anna-fugu' \| sudo tee \/etc\/ssh\/principals\/deck-agent/);
  // несколько агентов — все их имена входа в файле
  const two = setupScript({ ca_public_key: "ssh-ed25519 AAAAC3 ca", principal_prefix: "deck-u-anna-" }, "deck-agent", ["fugu", "duty"]);
  assert.match(two, /'deck-u-anna-fugu' 'deck-u-anna-duty' \| sudo tee/);
  assert.match(sh, /TrustedUserCAKeys/);
  assert.doesNotMatch(sh, /authorized_keys|PasswordAuthentication yes/);
});
