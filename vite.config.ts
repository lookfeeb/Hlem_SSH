import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  optimizeDeps: {
    exclude: ["@tauri-apps/api"],
  },
  build: {
    manifest: true,
    chunkSizeWarningLimit: 1200,
    // Let the bundler follow lazy entry boundaries. A global antd chunk pulled
    // controls used only by settings, tables and editors into the boot path.
  },
  server: {
    host: "127.0.0.1",
    port: 5177,
    strictPort: true,
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
});
