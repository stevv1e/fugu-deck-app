/** Чаты на этом устройстве. Сервера нет: модели отвечают напрямую, по ключам из настроек. */
import { router, useFocusEffect } from "expo-router";
import { useCallback, useState } from "react";

import { useWide } from "@/desktop/wide";
import { PROVIDER_IDS } from "@/core/providers";
import { getKey } from "@/platform/secrets";
import { deleteChat, listChats, newChatHref, type ChatMeta } from "@/state/store";
import { Btn, Card, Empty, IconBtn, Notice, Row, Screen, Txt } from "@/ui/kit";

const short = (m: string) => m.split(":").pop() || m;

export default function Chats() {
  const [chats, setChats] = useState<ChatMeta[] | null>(null);
  const [noKeys, setNoKeys] = useState(false);
  const [armed, setArmed] = useState<string | null>(null);
  const wide = useWide();

  useFocusEffect(
    useCallback(() => {
      listChats().then(setChats, () => setChats([]));
      Promise.all(PROVIDER_IDS.map((p) => getKey(p).catch(() => null))).then((ks) => setNoKeys(ks.every((k) => !k)));
    }, []),
  );

  const remove = async (id: string) => {
    await deleteChat(id);
    setArmed(null);
    setChats(await listChats());
  };

  // компьютер: чаты — в боковой панели, здесь приветствие
  if (wide) {
    return (
      <Screen title="Fugu Local" back={false}>
        {noKeys ? (
          <Notice kind="warn" text="Ключей моделей нет. Добавьте ключ Sakana, Claude или DeepSeek в настройках — запросы пойдут с этого компьютера напрямую провайдеру." />
        ) : null}
        <Empty title="Выберите чат слева или начните новый" text="Сообщения уходят с этого компьютера прямо провайдеру модели, история хранится только здесь. Ctrl+N — новый чат.">
          <Row gap={8}>
            <Btn title="＋ Новый чат" onPress={() => router.push(newChatHref())} />
            <Btn title="Ключи и модели" kind="ghost" onPress={() => router.push("/settings")} />
          </Row>
        </Empty>
      </Screen>
    );
  }

  return (
    <Screen title="Fugu Local" back={false} right={<IconBtn glyph="⚙" label="Настройки" onPress={() => router.push("/settings")} />}>
      {noKeys ? (
        <Notice kind="warn" text="Ключей моделей нет. Добавьте ключ Sakana, Claude или DeepSeek в настройках — запросы пойдут с этого устройства напрямую провайдеру." />
      ) : null}
      <Btn title="＋ Новый чат" onPress={() => router.push(newChatHref())} />
      {chats && chats.length === 0 ? <Empty title="Чатов пока нет" text="История хранится только на этом устройстве." /> : null}
      {(chats ?? []).map((c) => (
        <Card key={c.id} onPress={() => router.push({ pathname: "/c/[id]", params: { id: c.id } })} onLongPress={() => setArmed(c.id)}>
          <Txt numberOfLines={1}>{c.title}</Txt>
          <Txt kind="small">
            {short(c.model)} · {new Date(c.updated).toLocaleString()}
          </Txt>
          {armed === c.id ? (
            <Row gap={8} style={{ flexWrap: "wrap" }}>
              <Btn title="Удалить чат" small kind="danger" onPress={() => remove(c.id)} />
              <Btn title="Отмена" small kind="ghost" onPress={() => setArmed(null)} />
            </Row>
          ) : null}
        </Card>
      ))}
      {chats && chats.length ? <Txt kind="small">Удерживайте чат, чтобы удалить его.</Txt> : null}
    </Screen>
  );
}
