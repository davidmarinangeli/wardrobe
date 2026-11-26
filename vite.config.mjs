import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { apiPlugins } from "./scripts/api-plugins.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local", "localhost"],
      fs: {
        // Keep Vite's built-in sensitive-file patterns and also deny the
        // private OAuth control directory, including custom nested data roots.
        deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.google-drive/**"],
      },
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      allowedHosts: ["localhost"],
    },
    // The plugin list and its order live in scripts/api-plugins.mjs, shared
    // with the standalone server (scripts/server.mjs).
    plugins: apiPlugins({ env, react: react() }),
  };
});
