/** Как версия показывается человеку: до выпуска все сборки — alpha. */
export const CHANNEL = "alpha";

export function versionLabel(version: string | undefined | null, commit?: string | null): string {
  const v = version ? `${CHANNEL}-${version}` : CHANNEL;
  return commit ? `${v} (${commit})` : v;
}
