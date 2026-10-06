/**
 * Канонический JSON — те же байты, что даёт backend/app/devices.py:canonical:
 *  • ключи объектов по возрастанию кодовых точек;
 *  • без пробелов;
 *  • строки как в JSON.stringify (Python с ensure_ascii=False экранирует тот же набор);
 *  • числа в формате JavaScript (сервер приводит к нему свои float);
 *  • UTF-8.
 * По этим байтам считается хэш аргументов инструмента и подписываются действия.
 */
import { utf8 } from "./bytes";

function cmpCodePoints(a: string, b: string): number {
  const ia = a[Symbol.iterator]();
  const ib = b[Symbol.iterator]();
  for (;;) {
    const x = ia.next();
    const y = ib.next();
    if (x.done || y.done) return x.done && y.done ? 0 : x.done ? -1 : 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d) return d;
  }
}

export function canonicalString(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(Object.is(v, -0) ? 0 : v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalString).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort(cmpCodePoints);
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalString(o[k])).join(",") + "}";
  }
  throw new Error(`canonical: неподдерживаемый тип ${typeof v}`);
}

export function canonical(v: unknown): Uint8Array {
  return utf8(canonicalString(v));
}
