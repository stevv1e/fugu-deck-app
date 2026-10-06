export type Theme = { id: string; name: string; note: string; swatch: string[] };

export const THEMES: Theme[] = [
  { id: "neon", name: "Neon Grid", note: "циан и маджента, сетка", swatch: ["#07080c", "#00f0ff", "#ff2a6d"] },
  { id: "matrix", name: "Matrix", note: "зелёный терминал, фосфор", swatch: ["#020603", "#39ff6a", "#e8ff3a"] },
  { id: "synthwave", name: "Synthwave", note: "закат 80-х, неоновая сетка", swatch: ["#120823", "#ff3fd4", "#ff8a3d"] },
  { id: "noir", name: "Neo Noir", note: "янтарь, красный, дождь", swatch: ["#0c0705", "#ff9d1c", "#ff3b30"] },
  { id: "abyss", name: "Abyss", note: "глубина, биолюминесценция", swatch: ["#020a13", "#3dfcd0", "#ff7ab8"] },
  { id: "amber", name: "Amber CRT", note: "монохромный ламповый монитор", swatch: ["#0a0700", "#ffb000", "#ff5f1f"] },
  { id: "toxic", name: "Toxic", note: "кислотный лайм, hazard", swatch: ["#0a0a06", "#c6ff00", "#ff2e88"] },
  { id: "sakura", name: "Sakura", note: "тёмная, мягкий розовый", swatch: ["#130c11", "#ff8fc7", "#ff4d6d"] },
  { id: "mono", name: "Mono", note: "чёрно-белый брутализм", swatch: ["#000000", "#ffffff", "#ff3b3b"] },
  { id: "ice", name: "Ice", note: "светлая, холодный синий", swatch: ["#eef3f8", "#0a6cff", "#e5345c"] },
];

const KEY = "fd:theme";

export function getTheme(): string {
  try {
    return localStorage.getItem(KEY) || "neon";
  } catch {
    return "neon";
  }
}

export function applyTheme(id: string) {
  document.documentElement.dataset.theme = id;
  const bg = THEMES.find((t) => t.id === id)?.swatch[0] || "#07080c";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
  try {
    localStorage.setItem(KEY, id);
  } catch {}
}
