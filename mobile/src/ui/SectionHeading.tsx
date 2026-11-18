import type { ReactNode } from "react";
import { View } from "react-native";

import { Row, Txt } from "./kit";

export function SectionHeading({ eyebrow, title, text, right }: { eyebrow?: string; title: string; text?: string; right?: ReactNode }) {
  return (
    <Row style={{ justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
      <View style={{ flex: 1, gap: 5 }}>
        {eyebrow ? <Txt kind="label">{eyebrow}</Txt> : null}
        <Txt kind="title">{title}</Txt>
        {text ? <Txt kind="dim" style={{ maxWidth: 600 }}>{text}</Txt> : null}
      </View>
      {right}
    </Row>
  );
}
