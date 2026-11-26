import { wardrobeImportApi } from "./import-job-api.mjs";
import { outfitsApi } from "./outfits-api.mjs";
import { inspoApi } from "./inspo-api.mjs";
import { wishlistApi } from "./wishlist-api.mjs";
import { suggestionsApi } from "./suggestions-api.mjs";
import { mirrorApi } from "./mirror-api.mjs";
import { responsiveImageApi } from "./responsive-image-api.mjs";
import { wardrobeSetupApi } from "./setup-api.mjs";
import { preferencesApi } from "./preferences-api.mjs";
import { colorProfileApi } from "./color-profile-api.mjs";
import { variantApi } from "./variant-api.mjs";
import { cheatSheetsApi } from "./cheat-sheets-api.mjs";
import { browserStateApi } from "./browser-state-api.mjs";
import { googleDriveApi } from "./google-drive-api.mjs";

/**
 * The one ordered list of Wardrobe server plugins, shared by `vite.config.mjs`
 * (dev and preview) and the standalone `scripts/server.mjs`.
 *
 * `googleDriveApi` always comes first: it mounts the private-file guard and the
 * archive admission middleware in front of every other API. The optional
 * `react` slot keeps `@vitejs/plugin-react` exactly where Vite has always had
 * it (right after the Drive plugin); the standalone server leaves it empty.
 *
 * `env` is the settings object every plugin reads before `process.env`.
 */
export function apiPlugins({ env, react } = {}) {
  return [
    googleDriveApi({ env }),
    ...(react ? [react] : []),
    responsiveImageApi(),
    wardrobeImportApi({ env }),
    outfitsApi({ env }),
    inspoApi({ env }),
    wishlistApi({ env }),
    suggestionsApi({ env }),
    mirrorApi({ env }),
    wardrobeSetupApi({ env }),
    preferencesApi({ env }),
    colorProfileApi({ env }),
    variantApi({ env }),
    cheatSheetsApi({ env }),
    browserStateApi({ env }),
  ];
}
