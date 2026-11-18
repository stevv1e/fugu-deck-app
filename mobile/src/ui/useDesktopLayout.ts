import { Platform, useWindowDimensions } from "react-native";

export function useDesktopLayout() {
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= 1080;
}
