// Shared fetch helper — replaces the 5 copies scattered across feature files.
// Usage: import { api } from "./api.js";

export async function api(path, options) {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || "Request failed.");
  return value;
}
