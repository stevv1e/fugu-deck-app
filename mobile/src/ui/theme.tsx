/** Темы — те же десять, что в веб-клиенте. Выбор хранится на устройстве. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Platform } from "react-native";

import { prefs } from "@/platform/storage";

export type Palette = {
  id: string;
  name: string;
  note: string;
  dark: boolean;
  bg: string;
  bg2: string;
  panel: string;
  panel2: string;
  line: string;
  line2: string;
  text: string;
  dim: string;
  faint: string;
  accent: string;
  accent2: string;
  warn: string;
  ok: string;
  onAccent: string;
  onAccent2: string;
  radius: number;
  monoText: boolean;
};

const t = (p: Omit<Palette, "radius" | "monoText" | "dark"> & Partial<Pick<Palette, "radius" | "monoText" | "dark">>): Palette => ({
  radius: 0,
  monoText: false,
  dark: true,
  ...p,
});

export const THEMES: Palette[] = [
  t({ id: "neon", name: "Neon Grid", note: "циан и маджента, сетка", bg: "#07080c", bg2: "#0c0e14", panel: "#10131b", panel2: "#151925", line: "#1f2433", line2: "#2b3246", text: "#d9deea", dim: "#7a829c", faint: "#4a5169", accent: "#00f0ff", accent2: "#ff2a6d", warn: "#f5d300", ok: "#3dffa2", onAccent: "#001317", onAccent2: "#ffffff" }),
  t({ id: "matrix", name: "Matrix", note: "зелёный терминал, фосфор", bg: "#020603", bg2: "#03100a", panel: "#06170d", panel2: "#0a2115", line: "#0e3320", line2: "#155a33", text: "#b9ffcb", dim: "#4fae6d", faint: "#2b6b42", accent: "#39ff6a", accent2: "#ff4d4d", warn: "#e8ff3a", ok: "#39ff6a", onAccent: "#001a08", onAccent2: "#ffffff", monoText: true }),
  t({ id: "synthwave", name: "Synthwave", note: "закат 80-х, неоновая сетка", bg: "#120823", bg2: "#180b2d", panel: "#211038", panel2: "#2a1546", line: "#3a1f5c", line2: "#56308a", text: "#f6e9ff", dim: "#b893dc", faint: "#72529c", accent: "#ff3fd4", accent2: "#ff8a3d", warn: "#ffd319", ok: "#2de2e6", onAccent: "#22002a", onAccent2: "#1a0800" }),
  t({ id: "noir", name: "Neo Noir", note: "янтарь, красный, дождь", bg: "#0c0705", bg2: "#130b07", panel: "#1a100a", panel2: "#22150d", line: "#33200f", line2: "#4d3017", text: "#f3dfc8", dim: "#b58d68", faint: "#6d5037", accent: "#ff9d1c", accent2: "#ff3b30", warn: "#ffd166", ok: "#8fd18b", onAccent: "#1d0d00", onAccent2: "#ffffff" }),
  t({ id: "abyss", name: "Abyss", note: "глубина, биолюминесценция", bg: "#020a13", bg2: "#03111d", panel: "#061a2a", panel2: "#0a2336", line: "#0f2f47", line2: "#18476a", text: "#d6edff", dim: "#71a0c2", faint: "#3f6886", accent: "#3dfcd0", accent2: "#ff7ab8", warn: "#ffe066", ok: "#3dfcd0", onAccent: "#00261b", onAccent2: "#2a0016", radius: 14 }),
  t({ id: "amber", name: "Amber CRT", note: "монохромный ламповый монитор", bg: "#0a0700", bg2: "#0f0a00", panel: "#150e00", panel2: "#1c1300", line: "#332300", line2: "#4d3500", text: "#ffb000", dim: "#b87e00", faint: "#6e4c00", accent: "#ffb000", accent2: "#ff5f1f", warn: "#ffd24d", ok: "#ffc933", onAccent: "#1a1000", onAccent2: "#1a0600", monoText: true }),
  t({ id: "toxic", name: "Toxic", note: "кислотный лайм, hazard", bg: "#0a0a06", bg2: "#10100a", panel: "#16160d", panel2: "#1e1e12", line: "#2c2c18", line2: "#45451f", text: "#f1f6d6", dim: "#a3ab7a", faint: "#5f6440", accent: "#c6ff00", accent2: "#ff2e88", warn: "#ffea00", ok: "#c6ff00", onAccent: "#141a00", onAccent2: "#ffffff" }),
  t({ id: "sakura", name: "Sakura", note: "тёмная, мягкий розовый", bg: "#130c11", bg2: "#1a1017", panel: "#22151f", panel2: "#2b1a27", line: "#3b2536", line2: "#57364f", text: "#fbeaf3", dim: "#c99bb7", faint: "#7f5b72", accent: "#ff8fc7", accent2: "#ff4d6d", warn: "#ffd6a5", ok: "#9ee6b8", onAccent: "#2a0718", onAccent2: "#ffffff", radius: 12 }),
  t({ id: "mono", name: "Mono", note: "чёрно-белый брутализм", bg: "#000000", bg2: "#080808", panel: "#0f0f0f", panel2: "#171717", line: "#262626", line2: "#3d3d3d", text: "#f5f5f5", dim: "#9a9a9a", faint: "#5c5c5c", accent: "#ffffff", accent2: "#ff3b3b", warn: "#ffffff", ok: "#ffffff", onAccent: "#000000", onAccent2: "#ffffff" }),
  t({ id: "ice", name: "Ice", note: "светлая, холодный синий", bg: "#eef3f8", bg2: "#e3eaf2", panel: "#ffffff", panel2: "#f4f7fb", line: "#d6dfe9", line2: "#bfccda", text: "#0f1a26", dim: "#53657b", faint: "#8b9bb0", accent: "#0a6cff", accent2: "#e5345c", warn: "#c98a00", ok: "#0f9d58", onAccent: "#ffffff", onAccent2: "#ffffff", radius: 10, dark: false }),
];

export const MONO = Platform.select({ ios: "Menlo", android: "monospace", default: "ui-monospace, SFMono-Regular, Menlo, monospace" });

type ThemeCtx = { p: Palette; setTheme(id: string): void };
const Ctx = createContext<ThemeCtx>({ p: THEMES[0], setTheme: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [id, setId] = useState("neon");
  useEffect(() => {
    prefs.get("fd:theme", "neon").then(setId);
  }, []);
  const value = useMemo<ThemeCtx>(
    () => ({
      p: THEMES.find((x) => x.id === id) ?? THEMES[0],
      setTheme: (next) => {
        setId(next);
        prefs.set("fd:theme", next);
      },
    }),
    [id],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);

/** Полупрозрачный цвет из #rrggbb. */
export function alpha(hex: string, a: number): string {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
