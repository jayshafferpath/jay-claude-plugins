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
    // The UI imports presentation constants from cli/lib/dashboard-queues.js so
    // the queue ordering has one source of truth. That path is outside `root`,
    // which the dev server refuses to serve unless it's allowlisted.
    fs: {
      allow: [".."],
    },
  },
  build: {
    outDir: "../dist",
  },
});
