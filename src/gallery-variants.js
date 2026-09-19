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

// How far a finger may travel across the art before the gesture counts as a
// peek rather than a tap. Below it the release still opens the sheet, so a
// slightly imprecise tap is not punished by doing nothing.
export const PEEK_SLOP = 8;

/**
 * Whether a drag has travelled far enough to be a peek instead of a tap.
 *
 * The card is a button, so every swipe is followed by a click. Without this
 * distinction a peek on a phone would also open the item sheet — and with the
 * threshold set too low, an ordinary tap with a shaky finger would open
 * nothing at all.
 */
export function isPeekGesture(originX, clientX) {
  return Math.abs(clientX - originX) > PEEK_SLOP;
}
