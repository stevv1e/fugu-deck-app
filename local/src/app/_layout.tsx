import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";

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
        <Themed />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
