import { Redirect, useLocalSearchParams } from "expo-router";

import { useApi } from "@/state/hooks";
import { useServers } from "@/state/servers";
import { Loading, Notice, Screen } from "@/ui/kit";
import { SectionHeading } from "@/ui/SectionHeading";
import { WorkspaceTasks } from "@/ui/WorkspaceTasks";

export default function Tasks() {
  const { sid } = useLocalSearchParams<{ sid: string }>();
  const { get } = useServers();
  const rec = get(sid);
  const { api, error } = useApi(sid);

  if (!rec) return <Redirect href="/" />;
  if (!rec.device) return <Redirect href={`/s/${sid}/login`} />;

  return (
    <Screen title="Задачи" back={false}>
      <SectionHeading eyebrow={rec.name} title="Центр задач" text="Активные и недавние запуски агентов. Откройте задачу, чтобы увидеть ход работы и запросы на подтверждение." />
      {error ? <Notice text={error} /> : null}
      {api ? <WorkspaceTasks api={api} sid={sid} /> : !error ? <Loading /> : null}
    </Screen>
  );
}
