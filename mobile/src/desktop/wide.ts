/**
 * Раскладка для компьютера: на широком окне (Windows, браузер) экраны встают справа от боковой панели,
 * как в веб-клиенте v1. На телефоне — всегда обычная стопка экранов.
 */
import { Platform, useWindowDimensions } from "react-native";

export const WIDE_MIN = 900;
/** Ширина колонки чтения: сообщения и формы не растягиваются на всё окно. */
export const READ_WIDTH = 860;

export function useWide(): boolean {
  const { width } = useWindowDimensions();
  return Platform.OS === "web" && width >= WIDE_MIN;
}
