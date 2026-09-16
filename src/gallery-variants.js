import { variantIdFor, variantImage, variantOwnImage } from "../shared/wardrobe-model.mjs";

export function galleryVariantPhotos(item) {
  const variants = Array.isArray(item?.variants) ? item.variants : [];
  const defaultVariant = variants.find((variant) => variant.id === item?.defaultVariantId) || variants[0];
  const defaultImage = variantImage(item);
  const orderedVariants = defaultVariant
    ? [defaultVariant, ...variants.filter((variant) => variant.id !== defaultVariant.id)]
    : variants;
  const seenImages = new Set();

  // A malformed/partially migrated record can briefly have no variants. Keep
  // its legacy projection visible until the next data refresh repairs it.
  if (!orderedVariants.length) {
    return defaultImage ? [{ variantId: item?.defaultVariantId || (item?.id ? variantIdFor(item.id) : null), image: defaultImage }] : [];
  }

  return orderedVariants.flatMap((variant, index) => {
    const image = index === 0 ? defaultImage : variantOwnImage(item, variant.id);
    if (!image || seenImages.has(image)) return [];
    seenImages.add(image);
    return [{ variantId: variant.id, image }];
  });
}

export function galleryVariantIndex(clientX, bounds, photoCount) {
  if (photoCount <= 1 || !bounds || bounds.width <= 0) return 0;
  const progress = (clientX - bounds.left) / bounds.width;
  return Math.max(0, Math.min(photoCount - 1, Math.floor(progress * photoCount)));
}
