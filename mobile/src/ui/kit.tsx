/** Базовые элементы интерфейса в стиле веб-клиента: панели с линиями, моноширинные метки, неон. */
import { router } from "expo-router";
import { create as createQr } from "qrcode";
import { useMemo, type ReactNode } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type TextInputProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { formatFp } from "@/core/invite";
import { READ_WIDTH, useWide } from "@/desktop/wide";

import { alpha, MONO, useTheme } from "./theme";

/** На широком окне содержимое экрана — колонкой по центру, а не во всю ширину. */
export function usePage(): ViewStyle | null {
  const wide = useWide();
  return wide ? { width: "100%", maxWidth: READ_WIDTH, alignSelf: "center", paddingHorizontal: 28, paddingTop: 22 } : null;
}

type TxtKind = "body" | "title" | "h2" | "label" | "dim" | "mono" | "small";

export function Txt({ kind = "body", color, style, children, numberOfLines, selectable }: {
  kind?: TxtKind;
  color?: string;
  style?: StyleProp<TextStyle>;
  children: ReactNode;
  numberOfLines?: number;
  selectable?: boolean;
}) {
  const { p } = useTheme();
  const base: TextStyle = {
    body: { fontSize: 15, lineHeight: 21, color: p.text },
    title: { fontSize: 26, fontWeight: "700", letterSpacing: 0.5, color: p.text },
    h2: { fontSize: 18, fontWeight: "700", color: p.text },
    label: { fontSize: 11, letterSpacing: 1.6, textTransform: "uppercase", color: p.dim, fontFamily: MONO },
    dim: { fontSize: 14, lineHeight: 20, color: p.dim },
    mono: { fontSize: 13, fontFamily: MONO, color: p.text },
    small: { fontSize: 12, lineHeight: 17, color: p.dim },
  }[kind] as TextStyle;
  const mono = p.monoText && kind !== "label" && kind !== "mono" ? { fontFamily: MONO } : null;
  return (
    <Text style={[base, mono, color ? { color } : null, style]} numberOfLines={numberOfLines} selectable={selectable}>
      {children}
    </Text>
  );
}

export function Screen({ children, scroll = true, title, back = true, right, footer }: {
  children: ReactNode;
  scroll?: boolean;
  title?: string;
  back?: boolean;
  right?: ReactNode;
  footer?: ReactNode;
}) {
  const { p } = useTheme();
  const page = usePage();
  const body = scroll ? (
    <ScrollView contentContainerStyle={[{ padding: 16, paddingBottom: 40, gap: 14 }, page]} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1 }}>{children}</View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={["top", "left", "right", "bottom"]}>
      {title !== undefined && <TopBar title={title} back={back} right={right} />}
      {/* Клавиатура не должна закрывать поле, в которое печатают (на Android окно под неё само не сжимается). */}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {body}
        {footer}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function TopBar({ title, back, right }: { title: string; back?: boolean; right?: ReactNode }) {
  const { p } = useTheme();
  const wide = useWide();
  if (wide) {
    // компьютер: заголовок слева, переходы — в боковой панели; «назад» остаётся для вложенных экранов
    return (
      <View style={[s.top, { height: 56, paddingHorizontal: 20, gap: 10, borderBottomColor: p.line, backgroundColor: p.bg }]}>
        {back && router.canGoBack() ? (
          <Pressable onPress={() => router.back()} accessibilityLabel="Назад" style={{ paddingRight: 4 }}>
            <Text style={{ color: p.dim, fontSize: 22, lineHeight: 24 }}>‹</Text>
          </Pressable>
        ) : null}
        <Text numberOfLines={1} style={{ flex: 1, color: p.text, fontFamily: MONO, fontWeight: "600", fontSize: 14.5 }}>
          {title}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{right}</View>
      </View>
    );
  }
  return (
    <View style={[s.top, { borderBottomColor: p.line, backgroundColor: p.bg }]}>
      {back && router.canGoBack() ? (
        <Pressable onPress={() => router.back()} hitSlop={12} style={s.topBtn} accessibilityLabel="Назад">
          <Text style={{ color: p.accent, fontSize: 26, lineHeight: 28 }}>‹</Text>
        </Pressable>
      ) : (
        <View style={s.topBtn} />
      )}
      <Txt kind="h2" numberOfLines={1} style={{ flex: 1, textAlign: "center", fontSize: 16 }}>
        {title}
      </Txt>
      <View style={[s.topBtn, { alignItems: "flex-end", width: undefined, minWidth: 36 }]}>{right}</View>
    </View>
  );
}

export function IconBtn({ glyph, onPress, label, color }: { glyph: string; onPress(): void; label: string; color?: string }) {
  const { p } = useTheme();
  return (
    <Pressable onPress={onPress} hitSlop={10} accessibilityLabel={label} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1, paddingHorizontal: 6 })}>
      <Text style={{ color: color || p.accent, fontSize: 20 }}>{glyph}</Text>
    </Pressable>
  );
}

export function Btn({ title, onPress, kind = "primary", busy, disabled, style, small }: {
  title: string;
  onPress(): void;
  kind?: "primary" | "ghost" | "danger" | "ok";
  busy?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
}) {
  const { p } = useTheme();
  const bg = { primary: p.accent, danger: p.accent2, ok: p.ok, ghost: "transparent" }[kind];
  const fg = { primary: p.onAccent, danger: p.onAccent2, ok: p.onAccent, ghost: p.accent }[kind];
  const off = disabled || busy;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        {
          backgroundColor: bg,
          borderColor: kind === "ghost" ? p.line2 : bg,
          borderWidth: 1,
          borderRadius: p.radius,
          paddingVertical: small ? 8 : 13,
          paddingHorizontal: small ? 12 : 18,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: off ? 0.5 : pressed ? 0.75 : 1,
        },
        style,
      ]}
    >
      {busy && <ActivityIndicator size="small" color={fg} />}
      <Text style={{ color: fg, fontWeight: "700", fontSize: small ? 13 : 15, letterSpacing: 0.6, fontFamily: p.monoText ? MONO : undefined, flexShrink: 1, textAlign: "center" }}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const { p } = useTheme();
  return (
    <View style={{ gap: 6 }}>
      <Txt kind="label">{label}</Txt>
      <TextInput
        placeholderTextColor={p.faint}
        autoCapitalize="none"
        autoCorrect={false}
        {...props}
        style={[
          {
            borderWidth: 1,
            borderColor: p.line2,
            backgroundColor: p.bg2,
            color: p.text,
            borderRadius: p.radius,
            paddingHorizontal: 12,
            paddingVertical: 11,
            fontSize: 15,
            fontFamily: p.monoText ? MONO : undefined,
          },
          props.style,
        ]}
      />
      {hint ? <Txt kind="small">{hint}</Txt> : null}
    </View>
  );
}

export function Card({ children, accent, style, onPress, onLongPress }: {
  children: ReactNode; accent?: string; style?: StyleProp<ViewStyle>; onPress?(): void; onLongPress?(): void;
}) {
  const { p } = useTheme();
  const box: ViewStyle = {
    backgroundColor: p.panel,
    borderColor: p.line,
    borderWidth: 1,
    borderLeftWidth: accent ? 3 : 1,
    borderLeftColor: accent || p.line,
    borderRadius: p.radius,
    padding: 14,
    gap: 8,
  };
  if (!onPress) return <View style={[box, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => [box, { backgroundColor: pressed ? p.panel2 : p.panel }, style]}>
      {children}
    </Pressable>
  );
}

export function Row({ children, style, gap = 10 }: { children: ReactNode; style?: StyleProp<ViewStyle>; gap?: number }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap }, style]}>{children}</View>;
}

export function Chip({ text, color }: { text: string; color?: string }) {
  const { p } = useTheme();
  const c = color || p.dim;
  return (
    <View style={{ borderWidth: 1, borderColor: alpha(c, 0.5), backgroundColor: alpha(c, 0.1), paddingHorizontal: 7, paddingVertical: 2, borderRadius: p.radius ? 99 : 0 }}>
      <Text style={{ color: c, fontSize: 10.5, fontFamily: MONO, letterSpacing: 0.8, textTransform: "uppercase" }}>{text}</Text>
    </View>
  );
}

export function Notice({ text, kind = "error" }: { text: string; kind?: "error" | "warn" | "info" | "ok" }) {
  const { p } = useTheme();
  const c = { error: p.accent2, warn: p.warn, info: p.accent, ok: p.ok }[kind];
  return (
    <View style={{ borderWidth: 1, borderColor: alpha(c, 0.55), backgroundColor: alpha(c, 0.08), padding: 12, borderRadius: p.radius }}>
      <Txt style={{ color: c, fontSize: 14, lineHeight: 20 }} selectable>
        {text}
      </Txt>
    </View>
  );
}

/** Отпечаток ключа сервера: 13 групп по 4 символа, крупно и моноширинно — его сверяют глазами. */
export function Fingerprint({ fp, highlight }: { fp: string; highlight?: boolean }) {
  const { p } = useTheme();
  const groups = formatFp(fp).split(" ");
  return (
    <View
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        gap: 8,
        padding: 12,
        borderWidth: 1,
        borderColor: highlight ? p.accent : p.line2,
        backgroundColor: p.bg2,
        borderRadius: p.radius,
      }}
      accessibilityLabel={"Отпечаток " + groups.join(" ")}
    >
      {groups.map((g, i) => (
        <Text key={i} selectable style={{ fontFamily: MONO, fontSize: 16, letterSpacing: 1.5, color: i % 2 ? p.text : p.accent, width: 58 }}>
          {g}
        </Text>
      ))}
    </View>
  );
}

/** QR из модулей-квадратов: без SVG и нативных зависимостей. */
export function QrCode({ value, size = 240 }: { value: string; size?: number }) {
  const m = useMemo(() => createQr(value, { errorCorrectionLevel: "M" }).modules, [value]);
  const quiet = 3;
  const cell = Math.floor(size / (m.size + quiet * 2));
  const rows = [];
  for (let y = 0; y < m.size; y++) {
    const cells = [];
    for (let x = 0; x < m.size; x++) {
      cells.push(<View key={x} style={{ width: cell, height: cell, backgroundColor: m.get(y, x) ? "#000" : "#fff" }} />);
    }
    rows.push(
      <View key={y} style={{ flexDirection: "row" }}>
        {cells}
      </View>,
    );
  }
  return (
    <View style={{ backgroundColor: "#fff", padding: cell * quiet, alignSelf: "center" }} accessibilityLabel="QR-код приглашения">
      {rows}
    </View>
  );
}

export function Loading({ text }: { text?: string }) {
  const { p } = useTheme();
  return (
    <View style={{ padding: 40, alignItems: "center", gap: 12 }}>
      <ActivityIndicator color={p.accent} />
      {text ? <Txt kind="dim">{text}</Txt> : null}
    </View>
  );
}

export function Empty({ title, text, children }: { title: string; text?: string; children?: ReactNode }) {
  return (
    <View style={{ paddingVertical: 36, paddingHorizontal: 8, alignItems: "center", gap: 10 }}>
      <Txt kind="h2" style={{ textAlign: "center" }}>
        {title}
      </Txt>
      {text ? (
        <Txt kind="dim" style={{ textAlign: "center" }}>
          {text}
        </Txt>
      ) : null}
      {children}
    </View>
  );
}

export function Divider() {
  const { p } = useTheme();
  return <View style={{ height: 1, backgroundColor: p.line, marginVertical: 4 }} />;
}

export function errText(e: unknown): string {
  return (e as any)?.message || String(e);
}

const s = StyleSheet.create({
  top: { height: 52, flexDirection: "row", alignItems: "center", paddingHorizontal: 8, borderBottomWidth: 1 },
  topBtn: { width: 36, justifyContent: "center" },
});
