import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/ws/monitor": {
        target: "ws://localhost:3210",
        ws: true,
      },
      "/api": {
        target: "http://localhost:3210",
      },
    },
  },
});
