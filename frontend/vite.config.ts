import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg", "apple-touch-icon.png"],
      manifest: {
        name: "Fugu Deck",
        short_name: "Fugu Deck",
        description: "Мобильный ИИ-агент для ваших репозиториев",
        theme_color: "#07080c",
        background_color: "#07080c",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//, /^\/cp\/api\//, /^\/s\//],
        runtimeCaching: [],
      },
    }),
  ],
  build: { chunkSizeWarningLimit: 900 },
  server: {
    proxy: {
      // одиночный режим: backend на :8000; кластер (локально): control-plane на :8080
      "/api": { target: "http://127.0.0.1:8000", changeOrigin: false },
      "/cp": { target: "http://127.0.0.1:8080", changeOrigin: false },
      "/s/": { target: "http://127.0.0.1:8080", changeOrigin: false },
    },
  },
});
