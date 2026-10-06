// Hermes не даёт crypto.getRandomValues — берём криптостойкий генератор ОС из expo-crypto.
import * as ExpoCrypto from "expo-crypto";

const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== "function") {
  g.crypto.getRandomValues = <T extends ArrayBufferView>(arr: T): T => ExpoCrypto.getRandomValues(arr as any) as T;
}
