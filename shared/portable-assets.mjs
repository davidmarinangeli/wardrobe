// Disk catalogs use portable POSIX paths. HTTP responses translate those paths
// to the existing routes so current browser clients keep their asset URLs.

const ROUTES = [
  ["/api/import/library/", "imported/"],
  ["/api/outfits/assets/", "outfits-assets/"],
  ["/api/inspo/assets/", "inspo-assets/"],
  ["/api/wishlist/assets/", "wishlist-assets/"],
  ["/api/cheat-sheets/assets/", "cheat-sheets-assets/"],
  ["/api/archive/assets/", ""],
];

const ROOTS = new Set([
  "imported", "outfits-assets", "outfit-images", "inspo-assets",
  "wishlist-assets", "cheat-sheets-assets", "originals",
]);
const ASSET_FIELDS = new Set([
  "asset", "image", "thumbnail", "modeledImage", "crop", "cropImage",
  "original", "sourceOriginal", "sourceOriginals", "referenceImage",
  "imagePath", "thumbnailPath", "modeledImagePath",
  "originalImage", "thumbnailImage", "aiImage", "aiThumbnailImage",
  "asset-path",
]);

export function isArchiveAssetField(field) { return ASSET_FIELDS.has(field); }

export function safeArchivePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0")) {
    throw new Error("Archive paths must be non-empty POSIX relative paths");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error(`Archive path must be relative: ${value}`);
  const segments = value.split("/");
  if (segments.some((part) => !part || part === "." || part === "..")) throw new Error(`Unsafe archive path: ${value}`);
  return segments.join("/");
}

function decodePath(value) {
  try { return decodeURIComponent(value); }
  catch { throw new Error(`Invalid encoded archive path: ${value}`); }
}

export function archivePathFromAsset(value) {
  if (typeof value !== "string") return null;
  for (const [route, root] of ROUTES) {
    if (!value.startsWith(route)) continue;
    const [pathname] = value.slice(route.length).split(/[?#]/, 1);
    const decoded = decodePath(pathname);
    const joined = `${root}${decoded}`;
    return safeArchivePath(joined);
  }
  // Already-portable paths are accepted only for known persistent roots.
  const [pathname] = value.split(/[?#]/, 1);
  const first = pathname.split("/")[0];
  if (!ROOTS.has(first)) return null;
  return safeArchivePath(pathname);
}

export function diskAssetPath(value) {
  const portable = archivePathFromAsset(value);
  if (portable) return portable;
  return value;
}

export function publicAssetUrl(value) {
  if (typeof value !== "string") return value;
  const [pathname, ...queryParts] = value.split("?");
  const query = queryParts.length ? `?${queryParts.join("?")}` : "";
  for (const [route, root] of ROUTES) {
    if (!root || !pathname.startsWith(root)) continue;
    const relative = safeArchivePath(pathname);
    const suffix = relative.slice(root.length);
    return `${route}${suffix.split("/").map(encodeURIComponent).join("/")}${query}`;
  }
  if (pathname.startsWith("originals/") || pathname.startsWith("outfit-images/")) {
    const relative = safeArchivePath(pathname);
    return `/api/archive/assets/${relative.split("/").map(encodeURIComponent).join("/")}${query}`;
  }
  return value;
}

export function mapCatalogAssets(value, mapper, parentField = "") {
  if (typeof value === "string") {
    if (!ASSET_FIELDS.has(parentField)) return value;
    const next = mapper(value);
    return next === undefined ? value : next;
  }
  if (Array.isArray(value)) return value.map((entry) => mapCatalogAssets(entry, mapper, parentField));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    // `path` is only an archive asset in this explicit provenance object;
    // inventory.files[].path and other labels remain byte-for-byte unchanged.
    mapCatalogAssets(entry, mapper, key === "path" && parentField === "sourceOriginal" ? "asset-path" : key),
  ]));
}

export function catalogForDisk(value) {
  return mapCatalogAssets(value, (asset) => {
    const portable = archivePathFromAsset(asset);
    return portable || asset;
  });
}

export function catalogForHttp(value) {
  return mapCatalogAssets(value, (asset) => publicAssetUrl(asset));
}

export function resolveArchiveAsset(dataDir, value) {
  const portable = archivePathFromAsset(value);
  if (!portable) throw new Error("Asset is not an archive-relative path");
  return portable;
}
