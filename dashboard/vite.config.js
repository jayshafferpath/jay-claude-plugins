import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "ui",
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3789",
    },
  },
  build: {
    outDir: "../dist",
  },
});
