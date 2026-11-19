import { Pressable, ScrollView, View } from "react-native";

import { Txt } from "./kit";
import { alpha, useTheme } from "./theme";
import { useDesktopLayout } from "./useDesktopLayout";

export type TabItem<T extends string> = { id: T; title: string };

export function Tabs<T extends string>({ items, value, onChange, label }: {
  items: TabItem<T>[];
  value: T;
  onChange(id: T): void;
  label: string;
}) {
  const { p } = useTheme();
  const desktop = useDesktopLayout();
  const buttons = items.map((item) => {
    const active = item.id === value;
    return (
      <Pressable
        key={item.id}
        onPress={() => onChange(item.id)}
        accessibilityRole="button"
        accessibilityLabel={item.title}
        accessibilityState={{ selected: active }}
        style={({ pressed }) => ({
          minHeight: 38,
          paddingHorizontal: 14,
          paddingVertical: 9,
          borderRadius: 9,
          borderWidth: 1,
          borderColor: active ? alpha(p.accent, 0.55) : pressed ? p.line2 : "transparent",
          backgroundColor: active ? alpha(p.accent, 0.1) : pressed ? p.panel2 : "transparent",
          justifyContent: "center",
        })}
      >
        <Txt numberOfLines={1} color={active ? p.accent : p.dim} style={{ fontSize: 13, fontWeight: active ? "700" : "500" }}>{item.title}</Txt>
      </Pressable>
    );
  });
  const style = { borderRadius: 12, borderWidth: 1, borderColor: p.line, backgroundColor: p.bg2, padding: 4 };
  if (desktop) return <View accessibilityLabel={label} style={[style, { flexDirection: "row", flexWrap: "wrap", gap: 4, alignSelf: "flex-start" }]}>{buttons}</View>;
  return (
    <ScrollView accessibilityLabel={label} horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ flexGrow: 1 }}>
      <View style={[style, { flexDirection: "row", gap: 2, minWidth: "100%" }]}>{buttons}</View>
    </ScrollView>
  );
}
