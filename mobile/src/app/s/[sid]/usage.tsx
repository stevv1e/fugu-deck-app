/** Расходы пространства на модели: всего, по моделям и по участникам (кто запускал и чьим ключом оплачено). */
import { useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";

import type { UsageReport } from "@/core/api";
import { useApi, useLoad } from "@/state/hooks";
import { Btn, Card, Empty, Loading, Notice, Row, Screen, Txt } from "@/ui/kit";
import { useTheme } from "@/ui/theme";

const PERIODS: [UsageReport["period"], string][] = [["today", "сегодня"], ["week", "7 дней"], ["month", "30 дней"], ["all", "всё время"]];
const usd = (n: number) => `$${n.toFixed(n > 0 && n < 1 ? 4 : 2)}`;
const tok = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} млн` : n >= 1e3 ? `${Math.round(n / 1e3)} тыс.` : String(n));

export default function Usage() {
  const { p } = useTheme();
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { api, error: apiError } = useApi(sid);
  const [period, setPeriod] = useState<UsageReport["period"]>("month");
  const { data, error } = useLoad(useCallback(() => api?.usage(period as "month") ?? null, [api, period]));
  const shown = data && data.period === period ? data : null;

  return (
    <Screen title="Расходы">
      {apiError || error ? <Notice text={(apiError || error)!} /> : null}
      <Row gap={6} style={{ flexWrap: "wrap" }}>
        {PERIODS.map(([k, t]) => <Btn key={k} small title={t} kind={k === period ? "primary" : "ghost"} onPress={() => setPeriod(k)} />)}
      </Row>
      {!shown && !error && !apiError ? <Loading /> : null}
      {shown ? (
        <>
          <Card accent={p.accent}>
            <Txt kind="label">всего</Txt>
            <Txt kind="h2">{usd(shown.total_usd)}</Txt>
            <Txt kind="small">{tok(shown.total_tokens)} токенов. Стоимость — по ценам моделей у агента; у моделей без опубликованной цены — оценка сверху.</Txt>
          </Card>
          <Txt kind="label">по моделям</Txt>
          {shown.models.length === 0 ? <Empty title="Расходов нет" text="За этот период агент не вызывал модели." /> : null}
          {shown.models.map((m) => (
            <Card key={m.model}>
              <Row style={{ justifyContent: "space-between" }}>
                <Txt kind="mono" numberOfLines={1} style={{ flex: 1, fontSize: 12.5 }}>{m.model}</Txt>
                <Txt style={{ fontWeight: "600" }}>{usd(m.usd)}</Txt>
              </Row>
              <Txt kind="small">{m.requests} запросов · {tok(m.tokens)} токенов</Txt>
            </Card>
          ))}
          {shown.members.length > 1 || shown.members.some((m) => m.paid_for_others_usd > 0) ? (
            <>
              <Txt kind="label">по участникам</Txt>
              {shown.members.map((m) => (
                <Card key={m.user_id ?? "none"} accent={m.me ? p.ok : undefined}>
                  <Row style={{ justifyContent: "space-between" }}>
                    <Txt style={{ fontWeight: "600", flex: 1 }} numberOfLines={1}>{m.name}{m.me ? " (вы)" : ""}</Txt>
                    <Txt>{usd(m.launched_usd)}</Txt>
                  </Row>
                  <Txt kind="small">
                    запустил на {usd(m.launched_usd)} ({m.requests} запросов) · оплачено его ключом {usd(m.paid_usd)}
                    {m.paid_for_others_usd > 0 ? `, из них за других ${usd(m.paid_for_others_usd)}` : ""}
                  </Txt>
                </Card>
              ))}
            </>
          ) : null}
        </>
      ) : null}
    </Screen>
  );
}
