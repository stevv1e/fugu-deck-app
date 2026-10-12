/**
 * Общие пространства и спонсорство — логика приложения без сети: что именно подписывается и в каком порядке
 * идут запросы. Подписанные действия проверяются той же схемой, что и на сервере (validateEnvelope).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { validateEnvelope } from "../src/core/actions";
import { jwkFromPoint, softKeygen, softSign } from "../src/core/crypto";
import { makeKey, type DeviceKeys } from "../src/core/keys";
import { grantBody, proposeModel, setMember, termsProblem, titleProblem, untilDate, withdrawSponsorship, deleteTeam, type ApiSession } from "../src/core/teams";

function softKeys(): DeviceKeys {
  const s = softKeygen(), c = softKeygen();
  return {
    alias: "t", storage: "software", attestation: null,
    session: makeKey(jwkFromPoint(s.point), async (d) => softSign(s.secret, d)),
    confirm: makeKey(jwkFromPoint(c.point), async (d) => softSign(c.secret, d)),
  };
}
const payload = (signed: any) => JSON.parse(Buffer.from(signed.jws.split(".")[1], "base64url").toString());

/** Сессия-заглушка: записывает запросы и отвечает по таблице. */
function fake(answers: Record<string, (body: any) => any>) {
  const calls: { method: string; path: string; body: any }[] = [];
  const s: ApiSession = {
    request: async (method, path, body) => {
      calls.push({ method, path, body });
      const a = answers[`${method} ${path}`];
      if (!a) throw new Error(`тест: нет ответа на ${method} ${path}`);
      return a(body);
    },
  };
  return { s, calls };
}

const NOW = Date.UTC(2026, 9, 12, 21, 30); // 12.10.2026 21:30 UTC

test("срок разрешения — дата по UTC, условия проверяются до подписи", () => {
  assert.equal(untilDate(7, NOW), "2026-10-19");
  assert.equal(untilDate(1, Date.UTC(2026, 11, 31, 23, 59)), "2027-01-01");
  assert.equal(termsProblem({ limitUsd: 20, days: 7 }), null);
  assert.match(termsProblem({ limitUsd: 0, days: 7 })!, /Лимит/);
  assert.match(termsProblem({ limitUsd: NaN, days: 7 })!, /Лимит/);
  assert.match(termsProblem({ limitUsd: 20, days: 0 })!, /Срок/);
  assert.match(termsProblem({ limitUsd: 20, days: 1.5 })!, /Срок/);
  assert.match(termsProblem({ limitUsd: 20, days: 7, perMemberUsdDay: 30 })!, /участника/);
  assert.equal(titleProblem(" Магазин "), null);
  assert.ok(titleProblem("") && titleProblem("я".repeat(61)));
});

test("разрешение спонсора: подписывается то, что назвал агент, и условия человека; схема та же, что на сервере", () => {
  const base = { space: "t-shop000001", chat: "c42", proposal: "p7", provider: "sakana", model: "fugu-max-v1.0", members: ["anna", "bob"] };
  const b = grantBody(base, { limitUsd: 20, days: 7, perMemberUsdDay: 5 }, NOW);
  assert.deepEqual(b, { type: "grant", chat: "c42", provider: "sakana", model: "fugu-max-v1.0", limit_usd: 20, limit_tokens: null,
    until: "2026-10-19", key_until: "2026-10-19", per_member_usd_day: 5, members: ["anna", "bob"], proposal: "p7" });
  validateEnvelope({ ...b, space: base.space, device_id: "d-0123456789abcdef", nonce: "n".repeat(16), ts: Math.floor(NOW / 1000) });
});

test("предложение модели: предложение → подпись → keyguard → агент; при отказе предложение отменяется", async () => {
  const keys = softKeys();
  const grant = { space: "t-shop000001", chat: "c42", proposal: "p7", provider: "sakana", model: "fugu-max-v1.0", members: ["anna", "bob"] };
  const space = fake({
    "POST /api/conversations/c42/model": () => ({ applied: false, need_grant: true, grant, proposal: { id: "p7" } }),
    "POST /api/model-proposals/p7/grant": () => ({ status: "pending", applied: false }),
    "POST /api/model-proposals/p7": () => ({ ok: true }),
  });
  const cluster = fake({ "POST /v1/grants": () => ({ grant_id: "g-00aa" }) });
  const r = await proposeModel(space.s, cluster.s, keys, "c42", { model: "sakana:fugu-max-v1.0", limitUsd: 20, days: 7 });
  assert.deepEqual(r, { status: "pending", applied: false });
  assert.deepEqual(space.calls.map((c) => c.path), ["/api/conversations/c42/model", "/api/model-proposals/p7/grant"]);
  assert.deepEqual(space.calls[0].body, { model: "sakana:fugu-max-v1.0", limit_usd: 20, days: 7, model_policy: null });
  assert.deepEqual(space.calls[1].body, { grant_id: "g-00aa" });
  const signed = payload(cluster.calls[0].body);
  assert.equal(signed.type, "grant");
  assert.equal(signed.space, "t-shop000001");
  assert.deepEqual([signed.chat, signed.proposal, signed.model, signed.limit_usd, signed.limit_tokens, signed.members], ["c42", "p7", "fugu-max-v1.0", 20, null, ["anna", "bob"]]);
  validateEnvelope(signed);

  // keyguard отказал (у спонсора нет ключа) — предложение не остаётся висеть без подписи
  const space2 = fake({
    "POST /api/conversations/c42/model": () => ({ applied: false, need_grant: true, grant, proposal: { id: "p7" } }),
    "POST /api/model-proposals/p7": () => ({ ok: true }),
  });
  const refused = fake({ "POST /v1/grants": () => { throw new Error("у спонсора нет ключа этого провайдера"); } });
  await assert.rejects(proposeModel(space2.s, refused.s, keys, "c42", { model: "sakana:fugu-max-v1.0", limitUsd: 20, days: 7 }), /нет ключа/);
  assert.deepEqual(space2.calls.at(-1), { method: "POST", path: "/api/model-proposals/p7", body: { approve: false } });

  // негодные условия не доходят ни до агента, ни до подписи
  const space3 = fake({});
  await assert.rejects(proposeModel(space3.s, cluster.s, keys, "c42", { model: "m", limitUsd: -1, days: 7 }), /Лимит/);
  assert.equal(space3.calls.length, 0);

  // одиночный сервер (без keyguard): модель применяется сразу, подписывать нечего
  const solo = fake({ "POST /api/conversations/c42/model": () => ({ applied: true }) });
  const none = fake({});
  assert.deepEqual(await proposeModel(solo.s, none.s, keys, "c42", { model: "m", limitUsd: 5, days: 1 }), { status: "approved", applied: true });
  assert.equal(none.calls.length, 0);
});

test("состав, удаление и отзыв спонсорства — подписанные действия для этого пространства", async () => {
  const keys = softKeys();
  const cluster = fake({
    "POST /v1/spaces/t-shop000001/members": () => ({ members: [] }),
    "POST /v1/spaces/t-shop000001/delete": () => ({}),
    "POST /v1/grants/revoke": () => ({ ok: true }),
  });
  await setMember(cluster.s, keys, "t-shop000001", "bob", "editor");
  await setMember(cluster.s, keys, "t-shop000001", "bob", "none");
  await deleteTeam(cluster.s, keys, "t-shop000001");
  const [add, drop, del] = cluster.calls.map((c) => payload(c.body));
  assert.deepEqual([add.type, add.space, add.member, add.role], ["role_change", "t-shop000001", "bob", "editor"]);
  assert.equal(drop.role, "none");
  assert.deepEqual([del.type, del.space], ["space_delete", "t-shop000001"]);
  [add, drop, del].forEach((a) => validateEnvelope(a));

  const space = fake({ "PATCH /api/conversations/c42/sponsor": () => ({ ok: true }) });
  await withdrawSponsorship(space.s, cluster.s, keys, "t-shop000001", "c42", "p7");
  const rev = payload(cluster.calls.at(-1)!.body);
  assert.deepEqual([rev.type, rev.space, rev.chat, rev.proposal], ["grant_revoke", "t-shop000001", "c42", "p7"]);
  validateEnvelope(rev);
  assert.deepEqual(space.calls[0].body, { withdraw: true });
  // отзыв в keyguard идёт ПЕРЕД отметкой в чате: если он не прошёл, чат не должен выглядеть «свободным», пока ключ ещё выдаётся
  const cluster2 = fake({ "POST /v1/grants/revoke": () => { throw new Error("keyguard недоступен"); } });
  const space2 = fake({});
  await assert.rejects(withdrawSponsorship(space2.s, cluster2.s, keys, "t-shop000001", "c42", "p7"), /недоступен/);
  assert.equal(space2.calls.length, 0);
});
