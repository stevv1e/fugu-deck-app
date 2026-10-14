/** Как версия показывается человеку: до выпуска все сборки — alpha. */
export const CHANNEL = "alpha";

export function versionLabel(version: string | undefined | null, commit?: string | null): string {
  const v = version ? `${CHANNEL}-${version}` : CHANNEL;
  return commit ? `${v} (${commit})` : v;
}

/** a новее b? Версии вида 1.2.3; непонятная строка — не новее (не дёргаем человека зря). */
export function isNewer(a: string | null | undefined, b: string | null | undefined): boolean {
  const parse = (v: string | null | undefined) => (/^\d+\.\d+\.\d+$/.test(v ?? "") ? v!.split(".").map(Number) : null);
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
