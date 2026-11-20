import { createElement } from "react";
import { Platform } from "react-native";

const CSS = `
  * { scrollbar-width: thin; scrollbar-color: transparent transparent; }
  *:hover { scrollbar-color: rgba(150, 163, 184, .38) transparent; }
  *::-webkit-scrollbar { width: 8px; height: 8px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: transparent; border-radius: 999px; }
  *:hover::-webkit-scrollbar-thumb { background: rgba(150, 163, 184, .32); }
  *::-webkit-scrollbar-thumb:hover { background: rgba(150, 163, 184, .58); }
  *::-webkit-scrollbar-corner { background: transparent; }
`;

export function WebScrollbarStyle() {
  if (Platform.OS !== "web") return null;
  return createElement("style", { dangerouslySetInnerHTML: { __html: CSS } });
}
