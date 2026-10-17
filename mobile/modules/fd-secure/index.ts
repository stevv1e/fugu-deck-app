// Нативный модуль ключей устройства. На вебе и в Expo Go его нет — FdSecure === null.
import Native from "./src/FdSecureModule";
import { FdSecureDesktop } from "./src/FdSecureDesktop";

// В Windows-сборке (Tauri) нативного модуля Expo нет — его роль играет Rust-часть приложения.
export const FdSecure = Native ?? (FdSecureDesktop as unknown as typeof Native);
export { desktopInvoke, FdSecureDesktop } from "./src/FdSecureDesktop";
export * from "./src/FdSecure.types";
