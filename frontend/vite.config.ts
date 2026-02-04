import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: [
        "favicon.svg",
        "pdfjs/**",
        "manifest.webmanifest"
      ],
      manifest: {
        name: "pdfannotate",
        short_name: "pdfannotate",
        description: "Offline-first PDF annotate + sync",
        start_url: "/",
        display: "standalone",
        background_color: "#0b1220",
        theme_color: "#0b1220",
        icons: [{ src: "/favicon.svg", sizes: "128x128", type: "image/svg+xml" }]
      },
      workbox: {
        globPatterns: ["**/*.{js,mjs,css,html,ico,png,svg,webmanifest,woff2,wasm,bcmap,cmap}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5MB to include pdf.worker.mjs
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/pdfjs/"),
            handler: "CacheFirst",
            options: {
              cacheName: "pdfjs-assets",
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 }
            }
          },
          {
            urlPattern: ({ url }) => url.pathname.startsWith("/api/"),
            handler: "NetworkFirst",
            options: {
              cacheName: "api-cache",
              networkTimeoutSeconds: 3,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 5 }
            }
          }
        ]
      },
      devOptions: {
        enabled: false
      }
    })
  ],
  server: {
    proxy: {
      "/api": "http://localhost:3001"
    }
  }
});

