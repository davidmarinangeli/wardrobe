// Shared fetch helper — replaces the 5 copies scattered across feature files.
// Usage: import { api } from "./api.js";

export async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  // Plugin routes answer { error: "message" }; the standalone server's own
  // errors (a busy catalog among them) answer { error: { code, message } }.
  const message = typeof value.error === "string" ? value.error : value.error?.message;
  if (!response.ok) throw new Error(message || "Request failed.");
  return value;
}
