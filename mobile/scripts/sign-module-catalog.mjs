import fs from "node:fs";
import path from "node:path";
import { ed25519 } from "@noble/curves/ed25519.js";

const key = process.env.FUGU_MODULES_SIGNING_KEY ||
  (process.env.FUGU_MODULES_SIGNING_KEY_FILE ? fs.readFileSync(process.env.FUGU_MODULES_SIGNING_KEY_FILE, "utf8").trim() : "");
if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Задайте 32-байтовый Ed25519 ключ в FUGU_MODULES_SIGNING_KEY или путь в FUGU_MODULES_SIGNING_KEY_FILE");
const index = path.resolve(process.argv[2] || "index.json");
const signature = ed25519.sign(new Uint8Array(fs.readFileSync(index)), Uint8Array.from(Buffer.from(key, "hex")));
fs.writeFileSync(path.join(path.dirname(index), "index.sig"), Buffer.from(signature).toString("hex") + "\n");
console.log("index.sig обновлён; публичный ключ: " + Buffer.from(ed25519.getPublicKey(Uint8Array.from(Buffer.from(key, "hex")))).toString("hex"));
