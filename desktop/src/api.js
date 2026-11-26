// Thin wrappers over the Rust commands in src-tauri/src/commands.rs.
// Secrets never come back from Rust: only { present, hint }.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const serverState = () => invoke("server_state");
export const serverRestart = () => invoke("server_restart");
export const serverLogs = (limit) => invoke("server_logs", { limit });
export const serverHealth = () => invoke("server_health");
export const openWardrobe = () => invoke("open_wardrobe");
export const openInBrowser = () => invoke("open_in_browser");
export const getConfig = () => invoke("get_config");
export const setConfig = (patch) => invoke("set_config", { patch });
export const autostartGet = () => invoke("autostart_get");
export const autostartSet = (enabled) => invoke("autostart_set", { enabled });
export const secretStatus = () => invoke("secret_status");
export const secretSet = (name, value) => invoke("secret_set", { name, value });
export const secretDelete = (name) => invoke("secret_delete", { name });
export const appInfo = () => invoke("app_info");
export const dataImport = (from, replace) => invoke("data_import", { from, replace });
export const cacheStatus = () => invoke("cache_status");
export const cacheClearModels = () => invoke("cache_clear_models");
export const pickDirectory = (title, start) => invoke("pick_directory", { title: title ?? null, start: start ?? null });
/** `location`: "data" | "cache" | "logs" | "config". */
export const revealLocation = (location) => invoke("reveal_location", { location });
/** `topic`: "google-drive" | "releases". */
export const openHelp = (topic) => invoke("open_help", { topic });
export const updateState = () => invoke("update_state");
export const updateCheck = () => invoke("update_check");
export const updateInstall = () => invoke("update_install");
/** A version skips it; `null` stops skipping. */
export const updateSkip = (version) => invoke("update_skip", { version: version ?? null });

/** Calls `handler(state)` on every `server-state` event. Returns an unsubscribe function. */
export function onServerState(handler) {
  const unlisten = listen("server-state", (event) => handler(event.payload));
  return () => { unlisten.then((stop) => stop()).catch(() => {}); };
}

/** Calls `handler(status)` on every `update-state` event. Returns an unsubscribe function. */
export function onUpdateState(handler) {
  const unlisten = listen("update-state", (event) => handler(event.payload));
  return () => { unlisten.then((stop) => stop()).catch(() => {}); };
}

/** Calls `handler(sectionId)` when the shell asks to show a section (tray "Check for updates…"). */
export function onShowSection(handler) {
  const unlisten = listen("show-section", (event) => handler(event.payload));
  return () => { unlisten.then((stop) => stop()).catch(() => {}); };
}

export function errorText(error) {
  return typeof error === "string" ? error : error?.message || String(error);
}
