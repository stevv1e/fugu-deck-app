/** Раскладка для компьютера: на широком окне чаты — в боковой панели слева, как в Fugu Deck. На телефоне — стопка экранов. */
import { Platform, useWindowDimensions } from "react-native";

export const WIDE_MIN = 860;
/** Ширина колонки чтения: сообщения не растягиваются на всё окно. */
export const READ_WIDTH = 820;

export function useWide(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= WIDE_MIN;
}
