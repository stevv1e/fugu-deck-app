import type { NoteVerification, NoteVerificationState } from "@/core/api";

const LABELS: Record<NoteVerificationState, string> = {
  fresh: "подтверждено источником",
  stale: "источник изменился",
  unavailable: "источник недоступен",
  unverified: "не проверено",
};

export function verificationLabel(state?: NoteVerificationState): string {
  return LABELS[state ?? "unverified"];
}

export function verificationMessage(result: NoteVerification): string {
  if (result.state === "fresh") return "Источник не изменился: заметка подтверждена";
  if (result.state === "stale") return result.note || "Источник изменился: перечитайте его и обновите заметку";
  return "Источник недоступен: сведения не подтверждены";
}
