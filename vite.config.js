import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Prototype build: relative base so the page runs from any host (the Claude
// artifact, or GitHub Pages later). The real app switches to base
// "/PathFinder/" and adds vite-plugin-pwa, exactly as DayLoad does.
export default defineConfig({
  base: "./",
  plugins: [react()],
  build: { assetsInlineLimit: 0, chunkSizeWarningLimit: 900 },
});
