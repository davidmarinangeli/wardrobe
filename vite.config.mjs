import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import { wardrobeImportApi } from "./scripts/import-job-api.mjs";
import { outfitsApi } from "./scripts/outfits-api.mjs";
import { inspoApi } from "./scripts/inspo-api.mjs";
import { wishlistApi } from "./scripts/wishlist-api.mjs";
import { suggestionsApi } from "./scripts/suggestions-api.mjs";
import { mirrorApi } from "./scripts/mirror-api.mjs";
import { responsiveImageApi } from "./scripts/responsive-image-api.mjs";
import { wardrobeSetupApi } from "./scripts/setup-api.mjs";
import { preferencesApi } from "./scripts/preferences-api.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  return {
    optimizeDeps: {
      include: ["react", "react-dom/client"],
    },
    server: {
      host: "0.0.0.0",
      allowedHosts: ["terminal.local"],
      warmup: {
        clientFiles: ["./src/main.jsx"],
      },
    },
    preview: {
      host: "0.0.0.0",
      port: 4173,
      allowedHosts: ["localhost"],
    },
    plugins: [react(), responsiveImageApi(), wardrobeImportApi({ env }), outfitsApi({ env }), inspoApi({ env }), wishlistApi({ env }), suggestionsApi({ env }), mirrorApi({ env }), wardrobeSetupApi({ env }), preferencesApi({ env })],
  };
});
