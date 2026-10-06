import "@/platform/polyfill";

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ServersProvider } from "@/state/servers";
import { ThemeProvider, useTheme } from "@/ui/theme";

function Themed() {
  const { p } = useTheme();
  return (
    <>
      <StatusBar style={p.dark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: p.bg }, animation: "slide_from_right" }} />
    </>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <ServersProvider>
          <Themed />
        </ServersProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
