import { View } from "react-native";

import { BrandMark } from "@/ui/BrandMark";
import { Card, Chip, Notice, Row, Screen, Txt } from "@/ui/kit";
import { SectionHeading } from "@/ui/SectionHeading";
import { useTheme } from "@/ui/theme";

const CONCEPTS = [
  { id: "GIT", name: "Git Manager", text: "Репозитории, ветки, diff, pull request и ревью в рабочем пространстве.", tags: ["Git", "UI"] },
  { id: "WEB", name: "Web Research", text: "Поиск и чтение разрешённых страниц, отчёты со ссылками на источники.", tags: ["Сеть", "Поиск"] },
  { id: "SSH", name: "SSH Fleet", text: "Группы серверов, журнал команд и подтверждение опасных операций.", tags: ["SSH", "Shell"] },
  { id: "DOC", name: "Notes Sync", text: "Заметки Markdown и синхронизация через выбранный Git-репозиторий.", tags: ["Файлы", "Git"] },
  { id: "DCK", name: "Docker Control", text: "Контейнеры, образы, логи и проверка состояния удалённого daemon.", tags: ["Shell", "Сеть"] },
  { id: "RSS", name: "RSS Digest", text: "Новые публикации по расписанию и короткая сводка в заметках.", tags: ["Сеть", "Расписание"] },
];

export default function Modules() {
  const { p } = useTheme();
  return (
    <Screen title="Git-модули">
      <SectionHeading eyebrow="расширяемая платформа" title="Возможности из Git" text="Единый каталог модулей для мобильного и Windows-приложения. Интерфейс уже сверстан; установка появится после безопасного runtime." right={<BrandMark size={50} />} />
      <Notice kind="info" text="Это подготовительный экран, а не работающий магазин: репозиторий каталога и песочница ещё не опубликованы. Сейчас ничего не скачивается и не выполняется." />
      <Card accent={p.accent}>
        <Row style={{ justifyContent: "space-between", flexWrap: "wrap" }}><View><Txt kind="label">основной источник</Txt><Txt kind="mono" color={p.accent}>github.com/stevv1e/fugu-modules</Txt></View><Chip text="запланирован" color={p.warn} /></Row>
        <Txt kind="small">index.json · подписанный каталог · установка по commit и SHA-256 · ручные обновления с diff</Txt>
      </Card>
      <Txt kind="label">концепт каталога</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 13 }}>
        {CONCEPTS.map((m) => (
          <Card key={m.id} style={{ flexGrow: 1, flexBasis: 265, minHeight: 190 }}>
            <Row><View style={{ width: 39, height: 39, borderRadius: 9, borderWidth: 1, borderColor: p.line2, alignItems: "center", justifyContent: "center", backgroundColor: p.bg2 }}><Txt kind="mono" color={p.accent}>{m.id}</Txt></View><Chip text="концепт" /></Row>
            <Txt kind="h2">{m.name}</Txt>
            <Txt kind="small" style={{ flex: 1 }}>{m.text}</Txt>
            <Row gap={5} style={{ flexWrap: "wrap" }}>{m.tags.map((tag) => <Chip key={tag} text={tag} color={p.accent} />)}</Row>
          </Card>
        ))}
      </View>
      <Card>
        <Txt kind="label">модель безопасности</Txt>
        <Txt>Изолированная песочница вместо выполнения кода в основном контексте</Txt>
        <Txt kind="small">✓ Только объявленные разрешения и сетевые домены</Txt>
        <Txt kind="small">✓ Ограниченный RPC и лимиты памяти, процессора и времени</Txt>
        <Txt kind="small">✓ Никаких произвольных нативных модулей и прямого доступа к секретам</Txt>
        <Txt kind="small">✓ Повторное подтверждение при новых разрешениях после обновления</Txt>
      </Card>
    </Screen>
  );
}
