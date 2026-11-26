import { isIP } from "node:net";

/**
 * Host allow-list for the standalone server: the DNS-rebinding protection Vite
 * gives its dev and preview servers for free.
 *
 * A request is accepted when its `Host` header (port stripped, lower-cased,
 * trailing dot removed) is:
 *   - `localhost` or any `*.localhost` name,
 *   - an IP literal (`127.0.0.1`, `[::1]`, a LAN address): a rebinding attack
 *     needs a DNS name, so a literal address is as safe as Vite treats it,
 *   - an exact entry of the allow-list, or
 *   - a subdomain of a `.suffix` entry (`.ts.net` accepts `mac.tail1234.ts.net`
 *     but not `ts.net` itself).
 *
 * Feature 07 extends the list with the machine's tailnet name.
 */

export const ALLOWED_HOSTS_ENV = "WARDROBE_ALLOWED_HOSTS";

/** Splits comma separated lists (strings or arrays of strings) into normalized entries. */
export function parseAllowedHosts(...sources) {
  const entries = new Set();
  for (const source of sources.flat()) {
    if (typeof source !== "string") continue;
    for (const raw of source.split(",")) {
      const entry = raw.trim().toLowerCase().replace(/\.$/, "");
      if (entry && entry !== ".") entries.add(entry);
    }
  }
  return [...entries];
}

/** Returns the hostname part of a Host header, or "" when the header is malformed. */
export function hostnameFromHostHeader(header) {
  if (typeof header !== "string") return "";
  const value = header.trim().toLowerCase();
  if (!value || /[\s/@\\?#]/.test(value)) return "";
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) return "";
    const rest = value.slice(end + 1);
    if (rest && !/^:\d{1,5}$/.test(rest)) return "";
    return value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  if (colon >= 0) {
    if (!/^\d{1,5}$/.test(value.slice(colon + 1))) return "";
    return value.slice(0, colon).replace(/\.$/, "");
  }
  return value.replace(/\.$/, "");
}

export function isHostAllowed(header, allowedHosts = []) {
  const hostname = hostnameFromHostHeader(header);
  if (!hostname) return false;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  const bare = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  if (hostname.startsWith("[") ? isIP(bare) === 6 : isIP(bare) === 4) return true;
  for (const entry of allowedHosts) {
    if (entry.startsWith(".")) {
      if (hostname.endsWith(entry) && hostname.length > entry.length) return true;
    } else if (hostname === entry) return true;
  }
  return false;
}

/** connect-style middleware that rejects requests for a host outside the allow-list with 403. */
export function createHostAllowlist({ allowedHosts = [] } = {}) {
  const entries = parseAllowedHosts(allowedHosts);
  return function hostAllowlist(req, res, next) {
    const header = req.headers?.host;
    if (isHostAllowed(header, entries)) return next();
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({
      error: {
        code: "host_not_allowed",
        message: `Host "${typeof header === "string" ? header.slice(0, 255) : ""}" is not allowed. Add it with --allowed-hosts or ${ALLOWED_HOSTS_ENV}.`,
        host: typeof header === "string" ? header.slice(0, 255) : null,
      },
    }));
  };
}
