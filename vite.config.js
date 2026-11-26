import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

// Relative base so the same build runs from any host: GitHub Pages
// (https://<user>.github.io/PathFinder/) and the Claude preview artifact.
//
// The PWA plugin (same version and setup as DayLoad) writes the web app
// manifest and a service worker. Chrome needs both before it offers
// "Install"; without them it only offers a shortcut. The manifest's
// start_url and scope are relative, so they resolve to /PathFinder/ on
// GitHub Pages.
export default defineConfig({
  base: "./",
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png"],
      manifest: {
        name: "PathFinder",
        short_name: "PathFinder",
        description: "Trail-running segments by terrain and by train",
        start_url: ".",
        scope: ".",
        display: "standalone",
        background_color: "#C4E5FA",
        theme_color: "#F6F3EC",
        orientation: "portrait",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        // App shell only. The data (public/data/*.json) and the map tiles
        // are fetched from the network, so they are always current.
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  build: { assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
});
