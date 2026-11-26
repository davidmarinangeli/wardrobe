import path from "node:path";

/**
 * Where the server keeps derived, regenerable files (the background-removal
 * model, the drape portrait), and whether the desktop app owns configuration.
 *
 * A checkout keeps working without configuration: the cache defaults to
 * `<root>/.cache` (git-ignored). The desktop shell passes an absolute
 * `WARDROBE_CACHE_DIR` (or `--cache-dir`) under its app data directory, so
 * nothing is ever written inside the installed bundle.
 */
export const CACHE_DIR_ENV = "WARDROBE_CACHE_DIR";
export const DEFAULT_CACHE_DIR = ".cache";
export const MANAGED_CONFIG_ENV = "WARDROBE_MANAGED_CONFIG";
export const MANAGED_CONFIG_MESSAGE = "Configuration is managed by the Wardrobe desktop app";

const envSetting = (name, fallback = "") => process.env[name] || fallback;

/** The absolute cache directory. Relative values resolve against `root`. */
export function resolveCacheDir({ root = process.cwd(), setting = envSetting } = {}) {
  const configured = String(setting(CACHE_DIR_ENV) || "").trim();
  return path.resolve(root, configured || DEFAULT_CACHE_DIR);
}

/** `<cacheDir>/drapes`: the drape portrait and its manifest, served at `/drapes/*`. */
export function resolveDrapesDir({ root = process.cwd(), cacheDir, setting = envSetting } = {}) {
  const base = cacheDir ? path.resolve(root, cacheDir) : resolveCacheDir({ root, setting });
  return path.join(base, "drapes");
}

/** `<cacheDir>/transformers`: the `@huggingface/transformers` model cache (BiRefNet). */
export function resolveTransformersCacheDir({ root = process.cwd(), cacheDir, setting = envSetting } = {}) {
  const base = cacheDir ? path.resolve(root, cacheDir) : resolveCacheDir({ root, setting });
  return path.join(base, "transformers");
}

/** `WARDROBE_MANAGED_CONFIG` is on when it is `1` or `true` (any case). */
export function isManagedConfigValue(value) {
  return /^(?:1|true)$/i.test(String(value ?? "").trim());
}

export function isManagedConfig(setting = envSetting) {
  return isManagedConfigValue(setting(MANAGED_CONFIG_ENV));
}
