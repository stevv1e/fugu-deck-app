import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { Sidebar } from "@/desktop/Sidebar";
import { useWide } from "@/desktop/wide";
import { ThemeProvider, useTheme } from "@/ui/theme";

function Themed() {
  const { p } = useTheme();
  // широкое окно (компьютер): чаты слева, экран справа, без анимации перехода
  const wide = useWide();
  const stack = <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.bg }, animation: wide ? "none" : "slide_from_right" }} />;
  return (
    <>
      <StatusBar style={p.dark ? "light" : "dark"} />
      {wide ? (
        <View style={{ flex: 1, flexDirection: "row", backgroundColor: p.bg }}>
          <Sidebar />
          <View style={{ flex: 1, minWidth: 0 }}>{stack}</View>
        </View>
      ) : stack}
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Themed />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
