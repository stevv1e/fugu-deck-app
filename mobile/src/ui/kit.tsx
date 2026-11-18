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

import { alpha, MONO, useTheme } from "./theme";
import { useDesktopLayout } from "./useDesktopLayout";

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
    body: { fontSize: 15, lineHeight: 23, color: p.text },
    title: { fontSize: 29, lineHeight: 35, fontWeight: "700", letterSpacing: -0.7, color: p.text },
    h2: { fontSize: 18, lineHeight: 24, fontWeight: "600", letterSpacing: -0.2, color: p.text },
    label: { fontSize: 10, fontWeight: "600", letterSpacing: 1.5, textTransform: "uppercase", color: p.dim, fontFamily: MONO },
    dim: { fontSize: 14, lineHeight: 21, color: p.dim },
    mono: { fontSize: 13, fontFamily: MONO, color: p.text },
    small: { fontSize: 12, lineHeight: 18, color: p.dim },
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
  const desktop = useDesktopLayout();
  const body = scroll ? (
    <ScrollView contentContainerStyle={{ padding: desktop ? 30 : 18, paddingBottom: desktop ? 54 : 42, gap: desktop ? 18 : 15, width: "100%", maxWidth: desktop ? 1380 : 680, alignSelf: "center" }} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    <View style={{ flex: 1 }}>{children}</View>
  );
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: p.bg }} edges={desktop ? [] : ["top", "left", "right", "bottom"]}>
      {title !== undefined && <TopBar title={title} back={back} right={right} />}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior="padding">
        {body}
        {footer}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

export function TopBar({ title, back, right }: { title: string; back?: boolean; right?: ReactNode }) {
  const { p } = useTheme();
  const desktop = useDesktopLayout();
  return (
    <View style={[s.top, desktop ? s.topDesktop : null, { borderBottomColor: p.line, backgroundColor: p.bg }]}>
      {back && router.canGoBack() ? (
        <Pressable onPress={() => router.back()} hitSlop={12} style={[s.topBtn, desktop ? s.topBtnDesktop : null, { borderColor: p.line2 }]} accessibilityLabel="Назад">
          <Text style={{ color: p.accent, fontSize: 24, lineHeight: 26 }}>‹</Text>
        </Pressable>
      ) : (
        <View style={[s.topBtn, desktop ? s.topBtnDesktop : null]} />
      )}
      <View style={{ flex: 1, paddingHorizontal: 12 }}>
        <Txt kind={desktop ? "title" : "h2"} numberOfLines={1} style={desktop ? { fontSize: 23, lineHeight: 29 } : { textAlign: "center", fontSize: 17 }}>
          {title}
        </Txt>
        {desktop ? <Txt kind="small">Пространство Fugu Deck</Txt> : null}
      </View>
      <View style={[s.topBtn, desktop ? s.topBtnDesktop : null, { alignItems: "flex-end", width: undefined, minWidth: 36 }]}>{right}</View>
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
  const bg = { primary: p.accent, danger: p.accent2, ok: p.ok, ghost: p.panel }[kind];
  const fg = { primary: p.onAccent, danger: p.onAccent2, ok: p.onAccent, ghost: p.text }[kind];
  const off = disabled || busy;
  return (
    <Pressable
      onPress={off ? undefined : onPress}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!off, busy: !!busy }}
      style={({ pressed }) => [
        {
          backgroundColor: pressed && !off ? p.panel2 : bg,
          borderColor: kind === "ghost" ? p.line2 : bg,
          borderWidth: 1,
          borderRadius: Math.max(8, p.radius),
          minHeight: small ? 34 : 46,
          paddingVertical: small ? 7 : 11,
          paddingHorizontal: small ? 12 : 17,
          alignItems: "center",
          justifyContent: "center",
          flexDirection: "row",
          gap: 8,
          opacity: off ? 0.45 : pressed ? 0.82 : 1,
        },
        style,
      ]}
    >
      {busy && <ActivityIndicator size="small" color={fg} />}
      <Text style={{ color: fg, fontWeight: "600", fontSize: small ? 12 : 14, letterSpacing: 0.1, fontFamily: p.monoText ? MONO : undefined, flexShrink: 1, textAlign: "center" }}>
        {title}
      </Text>
    </Pressable>
  );
}

export function Field({ label, hint, ...props }: TextInputProps & { label: string; hint?: string }) {
  const { p } = useTheme();
  return (
    <View style={{ gap: 7 }}>
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
            borderRadius: Math.max(8, p.radius),
            paddingHorizontal: 14,
            paddingVertical: 12,
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
    borderColor: accent ? alpha(accent, 0.5) : p.line,
    borderWidth: 1,
    borderLeftWidth: accent ? 2 : 1,
    borderLeftColor: accent || p.line,
    borderRadius: Math.max(10, p.radius),
    padding: 16,
    gap: 10,
  };
  if (!onPress) return <View style={[box, style]}>{children}</View>;
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} style={({ pressed }) => [box, { backgroundColor: pressed ? p.panel2 : p.panel, borderColor: pressed ? p.line2 : box.borderColor }, style]}>
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
    <View style={{ borderWidth: 1, borderColor: alpha(c, 0.32), backgroundColor: alpha(c, 0.07), paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6 }}>
      <Text style={{ color: c, fontSize: 9.5, fontWeight: "600", fontFamily: MONO, letterSpacing: 0.45, textTransform: "uppercase" }}>{text}</Text>
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
  top: { height: 56, flexDirection: "row", alignItems: "center", paddingHorizontal: 12, borderBottomWidth: 1 },
  topDesktop: { height: 82, paddingHorizontal: 28 },
  topBtn: { width: 36, minHeight: 36, justifyContent: "center" },
  topBtnDesktop: { width: 38, minHeight: 38, borderWidth: 1, borderRadius: 9, alignItems: "center" },
});
