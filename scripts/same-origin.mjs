// Same-origin checks for state-changing requests. Shared by the import, setup
// and Google Drive plugins (scripts/import-job-api.mjs re-exports them).

/**
 * Whether a state-changing request came from a page served by this same server.
 * The dev server listens on every interface and these endpoints carry no
 * credentials, so without this any website open in the same browser could
 * POST to localhost and swap the AI keys, the provider or the reference photo.
 * Browsers always send Origin on POST; a request without one is refused.
 *
 * Behind a reverse proxy (`tailscale serve`, desktop Feature 07) the page's
 * origin is the proxy's public name. The request matches when the Origin host
 * equals the `Host` header or, when present, the first `X-Forwarded-Host`
 * value, with the same host comparison. A cross-site page cannot forge either
 * header: `X-Forwarded-Host` is not a CORS-safelisted request header, so a
 * browser only sends it after a preflight this server never approves.
 */
export function isSameOriginRequest(req) {
  const origin = parseOrigin(req.headers?.origin);
  if (!origin) return false;
  return [req.headers?.host, forwardedHost(req)].some((candidate) => sameHost(origin, candidate));
}

/**
 * Same-origin through a proxy only: the Origin host equals the first
 * `X-Forwarded-Host` value. The Google Drive control routes accept this in
 * addition to their configured callback origin (OAuth start excepted).
 */
export function isForwardedSameOriginRequest(req) {
  const origin = parseOrigin(req.headers?.origin);
  return Boolean(origin) && sameHost(origin, forwardedHost(req));
}

/** The first `X-Forwarded-Host` value (the host the client asked for), or "". */
export function forwardedHost(req) {
  const raw = req.headers?.["x-forwarded-host"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return "";
  return value.split(",", 1)[0].trim();
}

function parseOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch { return null; }
}

// A header value is compared as the authority of a URL with the origin's
// scheme, so letter case and an explicit default port (`:443` for https) do
// not matter. Anything but a bare host[:port] is refused.
function sameHost(origin, candidate) {
  if (typeof candidate !== "string" || !candidate || !/^[a-z0-9.\-[\]:]+$/i.test(candidate)) return false;
  try { return new URL(`${origin.protocol}//${candidate}`).host === origin.host; }
  catch { return false; }
}
