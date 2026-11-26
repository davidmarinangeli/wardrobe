// Pure helpers for the control panel: validation that mirrors the Rust side
// (src-tauri/src/config.rs), so the user sees a message before saving, and
// formatting. Rust validates again; these never replace that check.

/** The secrets the panel manages (src-tauri/src/secrets.rs SECRET_NAMES). */
export const SECRET_NAMES = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY_TEST",
  "GEMINI_API_KEY_PROD",
  "MINIMAX_API_KEY",
  "GOOGLE_DRIVE_CLIENT_SECRET",
];
/** Never written by the app, also refused as an override. */
const LEGACY_SECRET_NAMES = ["GEMINI_API_KEY"];
/** Set by the shell from its own settings (config.rs SHELL_OWNED_KEYS). */
export const SHELL_OWNED_KEYS = [
  "WARDROBE_DATA_DIR",
  "WARDROBE_CACHE_DIR",
  "WARDROBE_MANAGED_CONFIG",
  "WARDROBE_ALLOWED_HOSTS",
  "AI_PROVIDER",
  "NODE_OPTIONS",
];
/** Owned by the Google Drive section (config.rs DRIVE_ENV_KEYS). */
export const DRIVE_ENV_KEYS = ["GOOGLE_DRIVE_CLIENT_ID", "GOOGLE_DRIVE_REDIRECT_URI", "GOOGLE_DRIVE_FOLDER_ID"];

export const DRIVE_CALLBACK_PATH = "/api/google-drive/oauth/callback";
export const DEFAULT_PORT = 5173;

export const PROVIDERS = [
  { id: "openai", label: "OpenAI", keys: ["OPENAI_API_KEY"] },
  { id: "openrouter", label: "OpenRouter", keys: ["OPENROUTER_API_KEY"] },
  { id: "gemini", label: "Gemini", keys: ["GEMINI_API_KEY_TEST", "GEMINI_API_KEY_PROD"] },
  { id: "minimax", label: "MiniMax", keys: ["MINIMAX_API_KEY"] },
];
/** The server's default when AI_PROVIDER is not set. */
export const DEFAULT_PROVIDER = "openai";

const KEY_LINE = /^[A-Z0-9_]+=/;

/**
 * Parses the Advanced textarea: one `KEY=value` per line. Blank lines and
 * lines starting with `#` are skipped (and not kept). Returns the ordered
 * entries and one message per rejected line.
 */
export function parseOverrides(text) {
  const entries = [];
  const errors = [];
  const seen = new Set();
  String(text ?? "").split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    const at = `Line ${index + 1}`;
    if (!line || line.startsWith("#")) return;
    if (!KEY_LINE.test(line)) {
      errors.push({ line: index + 1, message: `${at}: write KEY=value, with KEY in capital letters, digits and _` });
      return;
    }
    const split = line.indexOf("=");
    const key = line.slice(0, split);
    const value = line.slice(split + 1).trim();
    if (SECRET_NAMES.includes(key) || LEGACY_SECRET_NAMES.includes(key)) {
      errors.push({ line: index + 1, message: `${at}: ${key} is a secret, use the key fields above` });
    } else if (key === "AI_PROVIDER") {
      errors.push({ line: index + 1, message: `${at}: choose the provider with the Provider select above` });
    } else if (SHELL_OWNED_KEYS.includes(key)) {
      errors.push({ line: index + 1, message: `${at}: ${key} is set by the desktop app itself (Storage section)` });
    } else if (DRIVE_ENV_KEYS.includes(key)) {
      errors.push({ line: index + 1, message: `${at}: set ${key} in the Google Drive section` });
    } else if (seen.has(key)) {
      errors.push({ line: index + 1, message: `${at}: ${key} appears twice` });
    } else {
      seen.add(key);
      entries.push({ key, value });
    }
  });
  return { entries, errors };
}

export function formatOverrides(entries) {
  return (entries ?? []).map(({ key, value }) => `${key}=${value}`).join("\n");
}

/** `{ port }` for a valid port, `{ error }` otherwise. */
export function validatePort(text) {
  const trimmed = String(text ?? "").trim();
  if (!/^\d+$/.test(trimmed)) return { error: "Enter a port number between 1 and 65535." };
  const port = Number(trimmed);
  if (port < 1 || port > 65535) return { error: "Enter a port number between 1 and 65535." };
  return { port };
}

export function defaultRedirectUri(port) {
  return `http://localhost:${port}${DRIVE_CALLBACK_PATH}`;
}

/** Same rules as the server: https, or http on a loopback host, on the callback path. */
export function validateRedirectUri(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const message = `Use a URL like ${defaultRedirectUri(DEFAULT_PORT)} (https, or http on localhost).`;
  let url;
  try { url = new URL(value); } catch { return message; }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return message;
  if (url.username || url.password || url.search || url.hash || url.pathname !== DRIVE_CALLBACK_PATH) return message;
  if (/\s/.test(value)) return message;
  return null;
}

export function validateFolderId(text) {
  const value = String(text ?? "").trim();
  if (!value) return null;
  if (value.length < 5 || value.length > 200 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return "A folder ID is 5 to 200 letters, digits, _ or -: the last part of the folder's URL.";
  }
  return null;
}

export function validateClientId(text) {
  const value = String(text ?? "").trim();
  if (value.length > 512 || /\s/.test(value)) return "A client ID is one word of at most 512 characters.";
  return null;
}

/** A single-line, non-empty key. Mirrors secrets::normalize_value. */
export function validateSecretValue(text) {
  const value = String(text ?? "").trim();
  if (!value) return "Paste the key first.";
  if (/[\r\n\0]/.test(value)) return "The key must be a single line.";
  return null;
}

/** "Not set", "Set, ends with …ab12", or "Set" for short values. */
export function secretLabel(status) {
  if (!status?.present) return "Not set";
  return status.hint && status.hint !== "…" ? `Set, ends with ${status.hint}` : "Set";
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[unit]}`;
}

export function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days} d ${hours} h`;
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return `${minutes} min`;
  return `${total} s`;
}

export function stateLabel(state) {
  switch (state?.state) {
    case "running": return state.adopted ? `Running on port ${state.port} (server started outside the app)` : `Running on port ${state.port}`;
    case "starting": return `Starting on port ${state.port}…`;
    case "failed": return "Failed";
    case "stopped": return "Stopped";
    default: return "…";
  }
}
