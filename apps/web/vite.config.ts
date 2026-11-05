import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const AGENT_URL = process.env.AGENT_URL ?? "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  server: {
    port: 5173,
    proxy: { "/api": { target: AGENT_URL, changeOrigin: true } }
  },
  preview: {
    port: 4173,
    proxy: { "/api": { target: AGENT_URL, changeOrigin: true } }
  }
});
