const ARCHIVE_MEDIA_ROOTS = new Set(["imported", "outfits-assets", "outfit-images", "inspo-assets", "wishlist-assets", "cheat-sheets-assets", "originals"]);
const ARCHIVE_API_PREFIXES = ["/api/import/library/", "/api/outfits/assets/", "/api/inspo/assets/", "/api/wishlist/assets/", "/api/cheat-sheets/assets/", "/api/archive/assets/"];

/** Routes every portable archive image through a generation-keyed API URL. */
export function archiveImageSource(src, generation) {
  if (typeof src !== "string" || !src || !Number.isSafeInteger(generation) || generation < 1) return src;
  let pathname = src;
  let suffix = "";
  if (!src.startsWith("/")) {
    const [relative, ...parts] = src.split(/[?#]/);
    if (!ARCHIVE_MEDIA_ROOTS.has(relative.split("/")[0])) return src;
    pathname = `/api/archive/assets/${relative.split("/").map(encodeURIComponent).join("/")}`;
    suffix = parts.length ? `?${parts.join("")}` : "";
  } else if (!ARCHIVE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    const [relative, ...parts] = src.slice(1).split(/[?#]/);
    if (!ARCHIVE_MEDIA_ROOTS.has(relative.split("/")[0])) return src;
    pathname = `/api/archive/assets/${relative.split("/").map(encodeURIComponent).join("/")}`;
    suffix = parts.length ? `?${parts.join("")}` : "";
  }
  if (!ARCHIVE_API_PREFIXES.some((prefix) => pathname.startsWith(prefix))) return src;
  const url = new URL(`${pathname}${suffix}`, "http://wardrobe.local");
  url.searchParams.set("archiveGeneration", String(generation));
  return `${url.pathname}${url.search}${url.hash}`;
}
