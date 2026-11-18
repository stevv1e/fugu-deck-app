import { StyleSheet, Text, View } from "react-native";

import { alpha, MONO, useTheme } from "./theme";

export function BrandMark({ size = 42 }: { size?: number }) {
  const { p } = useTheme();
  return (
    <View style={[styles.mark, { width: size, height: size, borderRadius: Math.max(9, size * 0.24), backgroundColor: alpha(p.accent, 0.1), borderColor: alpha(p.accent, 0.45) }]}>
      <View style={[styles.fin, { borderColor: p.accent, transform: [{ rotate: "45deg" }] }]} />
      <Text style={{ color: p.accent, fontFamily: MONO, fontWeight: "700", fontSize: size * 0.32 }}>F</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { borderWidth: 1, alignItems: "center", justifyContent: "center", overflow: "hidden" },
  fin: { position: "absolute", width: "68%", height: "68%", borderWidth: 1, opacity: 0.22 },
});
