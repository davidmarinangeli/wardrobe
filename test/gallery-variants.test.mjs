import assert from "node:assert/strict";
import test from "node:test";
import { galleryVariantIndex, galleryVariantPhotos } from "../src/gallery-variants.js";

test("gallery variant photos put the default first and omit unavailable or duplicate photos", () => {
  const item = {
    schemaVersion: 2,
    id: "shirt",
    defaultVariantId: "shirt-standard",
    image: "/standard.png",
    variants: [
      { id: "shirt-rolled", image: "/rolled.png" },
      { id: "shirt-missing" },
      { id: "shirt-standard", image: "/standard.png" },
      { id: "shirt-duplicate", image: "/standard.png" },
    ],
  };

  assert.deepEqual(galleryVariantPhotos(item), [
    { variantId: "shirt-standard", image: "/standard.png" },
    { variantId: "shirt-rolled", image: "/rolled.png" },
  ]);
});

test("gallery keeps a legacy image visible while no variants are available", () => {
  assert.deepEqual(galleryVariantPhotos({ id: "shirt", image: "/legacy.png", variants: [] }), [
    { variantId: "shirt-standard", image: "/legacy.png" },
  ]);
  assert.deepEqual(galleryVariantPhotos({ id: "empty", variants: [] }), []);
});

test("gallery variant index maps the card width to photos and clamps the edges", () => {
  const bounds = { left: 100, width: 300 };

  assert.equal(galleryVariantIndex(99, bounds, 3), 0);
  assert.equal(galleryVariantIndex(100, bounds, 3), 0);
  assert.equal(galleryVariantIndex(200, bounds, 3), 1);
  assert.equal(galleryVariantIndex(399, bounds, 3), 2);
  assert.equal(galleryVariantIndex(400, bounds, 3), 2);
});
