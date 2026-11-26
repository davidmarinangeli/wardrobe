import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The control-panel frontend. Port 1420 so it never collides with the
// Wardrobe server (5173) during `npm run tauri dev`.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "localhost",
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: ["es2022", "safari15", "chrome110"],
  },
});
