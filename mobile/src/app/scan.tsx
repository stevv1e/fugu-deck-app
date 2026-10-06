/** Сканер QR-приглашения. В QR — адрес сервера и отпечаток его ключа. */
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { router } from "expo-router";
import { useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

import { parseInvite } from "@/core/invite";
import { Btn, errText, Notice, Screen, Txt } from "@/ui/kit";
import { alpha, useTheme } from "@/ui/theme";

export default function Scan() {
  const { p } = useTheme();
  const [perm, request] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const handled = useRef(false);

  const onScan = (r: BarcodeScanningResult) => {
    if (handled.current) return;
    try {
      if (r.data.startsWith("fugudeck://join")) { // приглашение в кластер v2
        handled.current = true;
        router.replace({ pathname: "/join", params: Object.fromEntries(new URL(r.data).searchParams) });
        return;
      }
      const inv = parseInvite(r.data);
      handled.current = true;
      router.replace({ pathname: "/add", params: { url: inv.url, fp: inv.fp ?? "", name: inv.name ?? "" } });
    } catch (e) {
      setError(errText(e));
    }
  };

  if (!perm) return <Screen title="QR-приглашение">{null}</Screen>;

  if (!perm.granted) {
    return (
      <Screen title="QR-приглашение">
        <Txt kind="dim">Камера нужна только чтобы прочитать QR-приглашение сервера. Снимки никуда не отправляются.</Txt>
        {perm.canAskAgain ? (
          <Btn title="Разрешить камеру" onPress={request} />
        ) : (
          <Notice kind="warn" text="Доступ к камере запрещён в настройках телефона. Можно ввести адрес вручную." />
        )}
        <Btn title="Ввести адрес вручную" kind="ghost" onPress={() => router.replace("/add")} />
      </Screen>
    );
  }

  return (
    <Screen title="QR-приглашение" scroll={false}>
      <View style={{ flex: 1 }}>
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={onScan} />
        <View style={[StyleSheet.absoluteFill, { alignItems: "center", justifyContent: "center" }]} pointerEvents="none">
          <View style={{ width: 240, height: 240, borderWidth: 2, borderColor: p.accent, backgroundColor: alpha(p.accent, 0.04) }} />
        </View>
        <View style={{ position: "absolute", left: 16, right: 16, bottom: 24, gap: 10 }}>
          {error ? <Notice text={error} /> : <Txt style={{ textAlign: "center", color: "#fff" }}>Наведите камеру на QR из настроек сервера</Txt>}
          <Btn title="Ввести адрес вручную" kind="ghost" onPress={() => router.replace("/add")} style={{ backgroundColor: alpha(p.bg, 0.8) }} />
        </View>
      </View>
    </Screen>
  );
}
