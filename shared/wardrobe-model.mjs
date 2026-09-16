// Wardrobe schema v2.  This module is deliberately dependency-free so the
// browser, Vite APIs, the bulk importer and Codex skills can agree on the same
// shape without pulling server code into the client.

export const WARDROBE_SCHEMA_VERSION = 2;

const asText = (value, fallback = "") => typeof value === "string" ? value.trim() : fallback;
const asTags = (value) => Array.isArray(value)
  ? [...new Set(value.filter((tag) => typeof tag === "string").map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 24)
  : [];

export function variantIdFor(itemId, suffix = "standard") {
  const safeSuffix = asText(suffix, "standard").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "standard";
  return `${itemId}-${safeSuffix}`;
}

function normalizeAsset(asset, fallbackImage = null) {
  if (typeof asset === "string") return { image: asset, thumbnail: asset, revision: 1, status: "current" };
  if (!asset || typeof asset !== "object" || Array.isArray(asset)) {
    return fallbackImage ? { image: fallbackImage, thumbnail: fallbackImage, revision: 1, status: "current" } : null;
  }
  const image = asText(asset.image || asset.url, fallbackImage || "") || null;
  return image ? {
    ...asset,
    image,
    thumbnail: asText(asset.thumbnail, image),
    revision: Number.isFinite(Number(asset.revision)) ? Math.max(1, Number(asset.revision)) : 1,
    status: ["current", "stale", "pending", "rejected"].includes(asset.status) ? asset.status : "current",
  } : null;
}

function normalizeModeled(value, legacy = null) {
  const source = value && typeof value === "object" ? value : {};
  const image = asText(source.image || source.url, typeof value === "string" ? value : legacy || "") || null;
  return {
    ...source,
    image,
    status: ["processing", "error", "approved", "stale"].includes(source.status) ? source.status : (image ? "approved" : null),
    error: asText(source.error, null) || null,
    tier: ["standard", "premium", "openrouter"].includes(source.tier) ? source.tier : null,
    revision: source.revision != null && Number.isFinite(Number(source.revision)) ? Math.max(1, Number(source.revision)) : (image ? 1 : null),
    sourceRevision: source.sourceRevision != null && Number.isFinite(Number(source.sourceRevision)) ? Math.max(1, Number(source.sourceRevision)) : null,
  };
}

export function normalizeReference(reference, index = 0, itemId = "item") {
  const source = reference && typeof reference === "object" ? reference : {};
  const id = asText(source.id, `${itemId}-reference-${index + 1}`);
  const role = source.role === "detail" ? "detail" : "view";
  const scope = source.scope === "variant" ? "variant" : "item";
  const original = asText(source.original || source.originalAsset || source.originalUrl, "") || null;
  const crop = asText(source.crop || source.cropAsset || source.cropUrl, "") || null;
  const asset = asText(source.asset || source.url, "") || original || crop;
  return {
    ...source,
    id,
    asset: asset || null,
    original,
    crop,
    role,
    scope,
    variantId: scope === "variant" ? (asText(source.variantId, "") || null) : null,
    label: asText(source.label, role === "detail" ? "Detail" : "View") .slice(0, 120),
    distinctive: source.distinctive === true,
    revision: Number.isFinite(Number(source.revision)) ? Math.max(1, Number(source.revision)) : 1,
  };
}

export function normalizeVariant(value, itemId, index = 0, fallback = {}) {
  const source = value && typeof value === "object" ? value : {};
  const fallbackId = index === 0 ? variantIdFor(itemId) : variantIdFor(itemId, `variant-${index + 1}`);
  const id = asText(source.id, fallback.id || fallbackId);
  const image = asText(source.image || source.cutout?.image || source.cutout?.url, fallback.image || "") || null;
  const modeledLegacy = source.modeledImage || fallback.modeledImage || null;
  const cutout = normalizeAsset(source.cutout, image);
  const modeledPhoto = normalizeModeled(source.modeledPhoto, modeledLegacy);
  const modeledImage = modeledPhoto.image;
  return {
    ...source,
    id,
    name: asText(source.name, fallback.name || "Standard").slice(0, 120),
    description: asText(source.description, fallback.description || "").slice(0, 500),
    tags: asTags(source.tags ?? fallback.tags),
    origin: source.origin === "generated" ? "generated" : "photo",
    sourceRefs: Array.isArray(source.sourceRefs) ? [...new Set(source.sourceRefs.filter((ref) => typeof ref === "string"))] : [],
    cutout,
    modeledPhoto,
    // These aliases make the transition safe for existing components and
    // third-party scripts while all new code can use the nested assets.
    image: image || cutout?.image || null,
    thumbnail: asText(source.thumbnail, image || cutout?.thumbnail || "") || null,
    modeledImage,
    modeledStatus: modeledPhoto.status,
    modeledError: modeledPhoto.error,
    modeledTier: modeledPhoto.tier,
    approvalStatus: ["approved", "pending", "rejected"].includes(source.approvalStatus) ? source.approvalStatus : "approved",
    assetRevision: Number.isFinite(Number(source.assetRevision)) ? Math.max(1, Number(source.assetRevision)) : 1,
    createdAt: asText(source.createdAt, fallback.createdAt || new Date().toISOString()),
    updatedAt: asText(source.updatedAt, new Date().toISOString()),
  };
}

export function normalizeItemV2(value, now = new Date().toISOString()) {
  const source = value && typeof value === "object" ? value : {};
  const id = asText(source.id);
  if (!id) return null;
  const legacyVariant = {
    id: variantIdFor(id),
    name: "Standard",
    tags: source.tags,
    image: source.image,
    thumbnail: source.thumbnail,
    modeledImage: source.modeledImage,
    origin: "photo",
    sourceRefs: source.importJobId ? [source.importJobId] : [],
    createdAt: source.createdAt,
  };
  const hasExplicitVariants = Array.isArray(source.variants) && source.variants.length > 0;
  const rawVariants = hasExplicitVariants ? source.variants : [legacyVariant];
  // Legacy fields may seed the synthetic Standard variant, but they must not
  // make an explicit pending variant look as if it already owns that image.
  const variants = rawVariants.map((variant, index) => normalizeVariant(variant, id, index, hasExplicitVariants ? {} : legacyVariant));
  const requestedDefault = asText(source.defaultVariantId, "");
  const defaultVariantId = variants.some((variant) => variant.id === requestedDefault) ? requestedDefault : variants[0].id;
  const defaultVariant = variants.find((variant) => variant.id === defaultVariantId) || variants[0];
  const references = Array.isArray(source.references)
    ? source.references.map((reference, index) => normalizeReference(reference, index, id))
    : [];
  const color = asText(source.color, "#d8d0c2").toLowerCase();
  const secondaryColor = asText(source.secondaryColor, "").toLowerCase() || null;
  return {
    ...source,
    schemaVersion: WARDROBE_SCHEMA_VERSION,
    id,
    name: asText(source.name, defaultVariant.name || "Wardrobe item").slice(0, 120),
    part: asText(source.part, "upperbody"),
    color,
    secondaryColor,
    palette: Array.isArray(source.palette) && source.palette.length ? source.palette : [color, secondaryColor].filter(Boolean),
    tags: asTags(source.tags ?? defaultVariant.tags),
    defaultVariantId,
    variants,
    references,
    // Legacy projections intentionally remain. They allow old clients and
    // scripts to keep reading while migration rolls through a live install.
    image: defaultVariant.image || defaultVariant.cutout?.image || source.image || null,
    thumbnail: defaultVariant.thumbnail || defaultVariant.cutout?.thumbnail || source.thumbnail || null,
    modeledImage: defaultVariant.modeledImage || null,
    modeledStatus: defaultVariant.modeledStatus || null,
    modeledError: defaultVariant.modeledError || null,
    modeledTier: defaultVariant.modeledTier || null,
    updatedAt: asText(source.updatedAt, now),
  };
}

export function migrateLibrary(records = [], now = new Date().toISOString()) {
  if (!Array.isArray(records)) throw new Error("Wardrobe library must be an array");
  const items = records.map((record) => normalizeItemV2(record, now)).filter(Boolean);
  const changed = JSON.stringify(items) !== JSON.stringify(records);
  return { items, changed };
}

function normalizedItem(item) {
  if (!item) return null;
  const alreadyNormalized = item.schemaVersion === WARDROBE_SCHEMA_VERSION
    && Array.isArray(item.variants)
    && item.variants.some((variant) => variant?.id === item.defaultVariantId);
  return alreadyNormalized ? item : normalizeItemV2(item);
}

export function itemVariant(item, variantId = null) {
  if (!item) return null;
  // ponytail: normalize once at the boundary; callers only need the selected
  // variant and should not pay for a second whole-item normalization.
  const normalized = normalizedItem(item);
  if (!normalized?.variants?.length) return null;
  const selectedId = variantId || normalized.defaultVariantId;
  return normalized.variants.find((variant) => variant.id === selectedId)
    || normalized.variants.find((variant) => variant.id === normalized.defaultVariantId)
    || null;
}

export function variantOwnImage(item, variantId = null) {
  const variant = itemVariant(item, variantId);
  return variant?.image || variant?.cutout?.image || variant?.thumbnail || variant?.cutout?.thumbnail || null;
}

export function variantImage(item, variantId = null) {
  return variantOwnImage(item, variantId) || item?.image || item?.thumbnail || null;
}

/** Return only a usable, approved cutout owned by the selected variant. */
export function variantApprovedImage(item, variantId = null) {
  const normalized = normalizedItem(item);
  if (!normalized?.variants?.length) return null;
  const variant = normalized.variants.find((candidate) => candidate.id === (variantId || normalized.defaultVariantId));
  const image = variant?.cutout?.image;
  return variant?.approvalStatus === "approved"
    && variant?.cutout?.status === "current"
    && typeof image === "string"
    && image.trim()
    ? image
    : null;
}

/**
 * Resolve an outfit's canonical pieces to the item artwork used by the UI.
 * Legacy itemIds remain accepted at this boundary while persisted v2 records
 * use pieces with an explicit variantId.
 */
export function resolveOutfitPieces(outfit, items = []) {
  const itemMap = items instanceof Map
    ? items
    : Array.isArray(items)
      ? new Map(items.map((item) => [item.id, item]))
      : new Map(Object.entries(items || {}));
  const rawPieces = Array.isArray(outfit?.pieces)
    ? outfit.pieces
    : (Array.isArray(outfit?.itemIds) ? outfit.itemIds.map((itemId) => ({ itemId, variantId: null })) : []);
  return rawPieces
    .filter((piece) => piece && typeof piece.itemId === "string")
    .map((piece) => {
      const item = itemMap.get(piece.itemId);
      if (!item) return null;
      const image = variantImage(item, piece.variantId);
      return { ...item, id: item.id, variantId: piece.variantId || null, image, thumbnail: image };
    })
    .filter(Boolean);
}

export function variantModeledImage(item, variantId = null) {
  return itemVariant(item, variantId)?.modeledImage || (variantId ? null : item?.modeledImage) || null;
}

export function migrateOutfit(value, items = []) {
  const source = value && typeof value === "object" ? value : {};
  const itemMap = new Map(items.map((item) => [item.id, item]));
  let pieces = Array.isArray(source.pieces)
    ? source.pieces.filter((piece) => piece && typeof piece.itemId === "string").map((piece) => ({ itemId: piece.itemId, variantId: piece.variantId || itemMap.get(piece.itemId)?.defaultVariantId || null }))
    : Array.isArray(source.itemIds)
      ? source.itemIds.filter((id) => typeof id === "string").map((itemId) => ({ itemId, variantId: itemMap.get(itemId)?.defaultVariantId || null }))
      : [];
  const seen = new Set();
  pieces = pieces.filter((piece) => {
    if (seen.has(piece.itemId)) return false;
    seen.add(piece.itemId);
    return true;
  });
  return {
    ...source,
    pieces,
    itemIds: pieces.map((piece) => piece.itemId),
    schemaVersion: WARDROBE_SCHEMA_VERSION,
  };
}

export function migrateOutfits(outfits = [], items = []) {
  if (!Array.isArray(outfits)) throw new Error("Outfits must be an array");
  const migrated = outfits.map((outfit) => migrateOutfit(outfit, items));
  return { outfits: migrated, changed: JSON.stringify(migrated) !== JSON.stringify(outfits) };
}

export function validateOutfitPieces(pieces, items = []) {
  if (!Array.isArray(pieces) || !pieces.length) throw Object.assign(new Error("An outfit needs at least one piece"), { status: 400 });
  const itemMap = new Map(items.map((item) => [item.id, item]));
  const seen = new Set();
  const normalized = [];
  for (const piece of pieces) {
    if (!piece || typeof piece.itemId !== "string" || typeof piece.variantId !== "string" || !piece.itemId || !piece.variantId) throw Object.assign(new Error("Every outfit piece requires itemId and variantId"), { status: 400 });
    if (seen.has(piece.itemId)) throw Object.assign(new Error("An outfit can contain each physical item only once"), { status: 400 });
    const item = itemMap.get(piece.itemId);
    if (!item) throw Object.assign(new Error(`Unknown wardrobe item: ${piece.itemId}`), { status: 400 });
    if (!item.variants?.some((variant) => variant.id === piece.variantId)) throw Object.assign(new Error(`Unknown variant ${piece.variantId} for ${piece.itemId}`), { status: 400 });
    seen.add(piece.itemId);
    normalized.push({ itemId: piece.itemId, variantId: piece.variantId });
  }
  return normalized;
}

export function markVariantAssetsStale(item, changedReference = null) {
  const next = normalizeItemV2(item);
  const changedReferenceId = typeof changedReference === "string" ? changedReference : changedReference?.id || null;
  const reference = next.references.find((candidate) => candidate.id === changedReferenceId)
    || (changedReference && typeof changedReference === "object" ? normalizeReference(changedReference, 0, next.id) : null);
  const affectsVariant = (variant) => {
    if (!changedReferenceId) return true;
    // A deleted reference is no longer in the item, so its scope must be
    // supplied as the second argument object by callers that need precision.
    if (!reference) return true;
    return reference.scope !== "variant" || reference.variantId === variant.id;
  };
  return {
    ...next,
    variants: next.variants.map((variant) => {
      if (affectsVariant(variant)) {
        return { ...variant, assetRevision: (variant.assetRevision || 1) + 1, cutout: variant.cutout ? { ...variant.cutout, status: "stale" } : null, modeledPhoto: variant.modeledPhoto?.image ? { ...variant.modeledPhoto, status: "stale" } : variant.modeledPhoto, modeledStatus: variant.modeledPhoto?.image ? "stale" : variant.modeledStatus };
      }
      return variant;
    }),
  };
}
