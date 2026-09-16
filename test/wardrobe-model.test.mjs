import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  markVariantAssetsStale,
  migrateLibrary,
  migrateOutfit,
  normalizeItemV2,
  resolveOutfitPieces,
  validateOutfitPieces,
  variantApprovedImage,
  variantIdFor,
  variantImage,
  variantOwnImage,
} from "../shared/wardrobe-model.mjs";
import { migrateDataDirectory } from "../scripts/wardrobe-data.mjs";
import { applyPreparedManifest } from "../scripts/bulk-import.mjs";
import { parseVariantRoute } from "../scripts/variant-api.mjs";

test("legacy item receives one stable Standard variant and keeps projections", () => {
  const legacy = { id: "shirt-1", name: "Shirt", part: "upperbody", image: "/shirt.png", modeledImage: "/shirt-model.png", tags: ["linen"] };
  const item = normalizeItemV2(legacy);
  assert.equal(item.schemaVersion, 2);
  assert.equal(item.variants.length, 1);
  assert.equal(item.defaultVariantId, variantIdFor("shirt-1"));
  assert.equal(item.variants[0].name, "Standard");
  assert.equal(item.variants[0].cutout.image, "/shirt.png");
  assert.equal(item.image, "/shirt.png");
  assert.equal(item.modeledImage, "/shirt-model.png");
});

test("library migration is idempotent", () => {
  const first = migrateLibrary([{ id: "i", image: "/i.png", part: "upperbody" }]).items;
  const second = migrateLibrary(first).items;
  assert.deepEqual(second, first);
});

test("outfits migrate itemIds to explicit pieces and preserve itemIds projection", () => {
  const item = normalizeItemV2({ id: "i", part: "upperbody", image: "/i.png" });
  const outfit = migrateOutfit({ id: "o", name: "Look", itemIds: ["i"] }, [item]);
  assert.deepEqual(outfit.pieces, [{ itemId: "i", variantId: item.defaultVariantId }]);
  assert.deepEqual(outfit.itemIds, ["i"]);
});

test("outfit piece validation rejects unknown variants and duplicate physical items", () => {
  const item = normalizeItemV2({ id: "i", part: "upperbody", image: "/i.png" });
  assert.throws(() => validateOutfitPieces([{ itemId: "i", variantId: "missing" }], [item]), /Unknown variant/);
  assert.throws(() => validateOutfitPieces([{ itemId: "i", variantId: item.defaultVariantId }, { itemId: "i", variantId: item.defaultVariantId }], [item]), /only once/);
});

test("variant API distinguishes collection, references, default and modeled routes", () => {
  assert.equal(parseVariantRoute("/api/wardrobe/items/i/variants").variantsCollection, true);
  assert.equal(parseVariantRoute("/api/wardrobe/items/i/references").referencesCollection, true);
  assert.equal(parseVariantRoute("/api/wardrobe/items/i/variants/v/default").action, "default");
  assert.equal(parseVariantRoute("/api/wardrobe/items/i/variants/v/modeled").action, "modeled");
});

test("a pending variant exposes its missing own image without losing the gallery fallback", () => {
  const item = normalizeItemV2({
    id: "shirt-1",
    image: "/standard.png",
    defaultVariantId: "shirt-1-standard",
    variants: [
      { id: "shirt-1-standard", name: "Standard", image: "/standard.png" },
      { id: "shirt-1-rolled", name: "Rolled", origin: "generated", approvalStatus: "pending" },
    ],
  });

  assert.equal(variantOwnImage(item, "shirt-1-rolled"), null);
  assert.equal(variantImage(item, "shirt-1-rolled"), "/standard.png");
});

test("variantApprovedImage requires an approved current own cutout", () => {
  const item = normalizeItemV2({
    id: "shirt",
    image: "/standard.png",
    variants: [
      { id: "shirt-standard", image: "/standard.png", approvalStatus: "approved" },
      { id: "shirt-pending", approvalStatus: "pending" },
      { id: "shirt-stale", image: "/stale.png", approvalStatus: "approved", cutout: { image: "/stale.png", status: "stale" } },
    ],
  });

  assert.equal(variantApprovedImage(item, "shirt-standard"), "/standard.png");
  assert.equal(variantApprovedImage(item, "shirt-pending"), null);
  assert.equal(variantApprovedImage(item, "shirt-stale"), null);
  assert.equal(variantApprovedImage(item, "missing"), null);
});

test("OpenRouter model choice survives variant normalization", () => {
  const item = normalizeItemV2({
    id: "shirt",
    defaultVariantId: "shirt-standard",
    variants: [{
      id: "shirt-standard",
      name: "Standard",
      modeledPhoto: { image: "/modeled.png", status: "approved", tier: "openrouter" },
    }],
  });

  assert.equal(item.variants[0].modeledTier, "openrouter");
});

test("reference staleness follows scope instead of variant source provenance", () => {
  const item = normalizeItemV2({
    id: "shirt",
    variants: [
      { id: "shirt-standard", image: "/standard.png", modeledImage: "/standard-modeled.png", sourceRefs: ["source-variant"] },
      { id: "shirt-rolled", image: "/rolled.png", modeledImage: "/rolled-modeled.png", sourceRefs: ["shirt-standard"] },
    ],
    references: [
      { id: "item-reference", scope: "item", asset: "/item.png", revision: 3 },
      { id: "rolled-reference", scope: "variant", variantId: "shirt-rolled", asset: "/rolled.png", revision: 2 },
    ],
  });

  const itemStale = markVariantAssetsStale(item, "item-reference");
  assert.deepEqual(itemStale.variants.map((variant) => variant.assetRevision), [2, 2]);
  assert.deepEqual(itemStale.variants.map((variant) => variant.cutout.status), ["stale", "stale"]);
  assert.deepEqual(itemStale.variants.map((variant) => variant.modeledStatus), ["stale", "stale"]);

  const rolledStale = markVariantAssetsStale(item, "rolled-reference");
  assert.deepEqual(rolledStale.variants.map((variant) => variant.assetRevision), [1, 2]);
  assert.equal(rolledStale.variants[0].cutout.status, "current");
  assert.equal(rolledStale.variants[1].modeledStatus, "stale");
});

test("outfit piece resolver keeps explicit variants and supports legacy itemIds", () => {
  const items = [normalizeItemV2({
    id: "shirt",
    image: "/standard.png",
    variants: [
      { id: "shirt-standard", image: "/standard.png" },
      { id: "shirt-rolled", image: "/rolled.png" },
    ],
  })];

  assert.deepEqual(resolveOutfitPieces({ pieces: [{ itemId: "shirt", variantId: "shirt-rolled" }] }, items).map(({ id, variantId, image }) => ({ id, variantId, image })), [
    { id: "shirt", variantId: "shirt-rolled", image: "/rolled.png" },
  ]);
  assert.deepEqual(resolveOutfitPieces({ itemIds: ["shirt"] }, items).map(({ id, variantId, image }) => ({ id, variantId, image })), [
    { id: "shirt", variantId: null, image: "/standard.png" },
  ]);
});

test("data migration writes recoverable backups once and is idempotent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "wardrobe-migration-"));
  const library = [{ id: "shirt", name: "Shirt", image: "/shirt.png" }];
  const outfits = [{ id: "look", name: "Look", itemIds: ["shirt"] }];
  const libraryFile = path.join(dir, "library.json");
  const outfitsFile = path.join(dir, "outfits.json");
  await writeFile(libraryFile, `${JSON.stringify(library)}\n`);
  await writeFile(outfitsFile, `${JSON.stringify(outfits)}\n`);

  const first = await migrateDataDirectory(dir);
  const firstLibrary = await readFile(libraryFile, "utf8");
  const firstOutfits = await readFile(outfitsFile, "utf8");
  assert.equal(first.changed, true);
  assert.deepEqual(JSON.parse(await readFile(`${libraryFile}.v1-backup.json`, "utf8")), library);
  assert.deepEqual(JSON.parse(await readFile(`${outfitsFile}.v1-backup.json`, "utf8")), outfits);
  assert.equal(first.outfits[0].pieces[0].variantId, first.items[0].defaultVariantId);

  const second = await migrateDataDirectory(dir);
  assert.equal(second.changed, false);
  assert.equal(second.backups, null);
  assert.equal(await readFile(libraryFile, "utf8"), firstLibrary);
  assert.equal(await readFile(outfitsFile, "utf8"), firstOutfits);
});

test("applying one prepared manifest twice keeps one stable item", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-import-"));
  const dataDir = path.join(root, "data");
  const itemsDir = path.join(root, "items");
  const manifestFile = path.join(root, "manifest.json");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  await mkdir(itemsDir, { recursive: true });
  await writeFile(path.join(itemsDir, "shirt.png"), png);
  await writeFile(manifestFile, JSON.stringify({
    version: 2,
    status: "prepared",
    items: [{
      name: "Shirt",
      part: "upperbody",
      color: "#112233",
      status: "accepted",
      variants: [{ id: "shirt-standard", name: "Standard", file: "shirt.png", origin: "photo", approvalStatus: "approved" }],
      references: [{ id: "shirt-reference-1", scope: "item", original: "photo.jpg", revision: 1 }],
    }],
  }));

  await applyPreparedManifest({ manifestFile, itemsDir, dataDir });
  const first = await readFile(path.join(dataDir, "library.json"), "utf8");
  await applyPreparedManifest({ manifestFile, itemsDir, dataDir });
  const second = await readFile(path.join(dataDir, "library.json"), "utf8");
  assert.equal(second, first);
  const records = JSON.parse(second);
  assert.equal(records.length, 1);
  assert.equal(records[0].variants.length, 1);
  assert.equal(records[0].defaultVariantId, "shirt-standard");
  assert.equal(records[0].references[0].id, "shirt-reference-1");
});

test("prepared manifests reject unsafe or colliding IDs before copying assets", async () => {
  const cases = [
    {
      label: "invalid variant id",
      variants: [{ id: "../escape", name: "Escape", file: "shirt.png" }],
      references: [],
      error: /Variant id contains invalid characters/,
    },
    {
      label: "derived variant collision",
      variants: [
        { name: "Rolled sleeves", file: "shirt.png" },
        { name: "Rolled-sleeves", file: "shirt.png" },
      ],
      references: [],
      error: /Duplicate variant id/,
    },
    {
      label: "invalid reference id",
      variants: [{ id: "shirt-standard", name: "Standard", file: "shirt.png" }],
      references: [{ id: "../reference" }],
      error: /Reference id contains invalid characters/,
    },
    {
      label: "duplicate reference id",
      variants: [{ id: "shirt-standard", name: "Standard", file: "shirt.png" }],
      references: [{ id: "reference-1" }, { id: "reference-1" }],
      error: /Duplicate reference id/,
    },
  ];

  for (const entry of cases) {
    const root = await mkdtemp(path.join(tmpdir(), "wardrobe-import-invalid-"));
    const dataDir = path.join(root, "data");
    const itemsDir = path.join(root, "items");
    const manifestFile = path.join(root, "manifest.json");
    await mkdir(itemsDir, { recursive: true });
    await writeFile(path.join(itemsDir, "shirt.png"), Buffer.from("not-a-real-image"));
    const libraryFile = path.join(dataDir, "library.json");
    const originalLibrary = `${JSON.stringify([{ id: "existing", image: "/existing.png" }])}\n`;
    await mkdir(dataDir, { recursive: true });
    await writeFile(libraryFile, originalLibrary);
    await writeFile(manifestFile, JSON.stringify({
      version: 2,
      status: "prepared",
      items: [{
        name: "Shirt",
        part: "upperbody",
        color: "#112233",
        status: "accepted",
        variants: entry.variants,
        references: entry.references,
      }],
    }));

    await assert.rejects(() => applyPreparedManifest({ manifestFile, itemsDir, dataDir }), entry.error, entry.label);
    assert.equal(await readFile(libraryFile, "utf8"), originalLibrary, `${entry.label} must not write the library`);
    assert.deepEqual(await readdir(path.join(dataDir, "imported")), [], `${entry.label} must not copy an asset`);
  }
});

test("prepared manifest preflight rejects a later item before copying an earlier item", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "wardrobe-import-preflight-"));
  const dataDir = path.join(root, "data");
  const itemsDir = path.join(root, "items");
  const manifestFile = path.join(root, "manifest.json");
  await mkdir(itemsDir, { recursive: true });
  await writeFile(path.join(itemsDir, "first.png"), Buffer.from("first-image"));
  await writeFile(path.join(itemsDir, "second.png"), Buffer.from("second-image"));
  const libraryFile = path.join(dataDir, "library.json");
  const originalLibrary = `${JSON.stringify([{ id: "existing", image: "/existing.png" }])}\n`;
  await mkdir(dataDir, { recursive: true });
  await writeFile(libraryFile, originalLibrary);
  await writeFile(manifestFile, JSON.stringify({
    version: 2,
    status: "prepared",
    items: [
      {
        name: "First",
        part: "upperbody",
        status: "accepted",
        variants: [{ id: "first-standard", name: "Standard", file: "first.png" }],
        references: [],
      },
      {
        name: "Second",
        part: "upperbody",
        status: "accepted",
        variants: [
          { id: "second-standard", name: "Standard", file: "second.png" },
          { id: "second-standard", name: "Duplicate", file: "second.png" },
        ],
        references: [],
      },
    ],
  }));

  await assert.rejects(
    () => applyPreparedManifest({ manifestFile, itemsDir, dataDir }),
    /Duplicate variant id "second-standard"/,
  );
  assert.equal(await readFile(libraryFile, "utf8"), originalLibrary);
  assert.deepEqual(await readdir(path.join(dataDir, "imported")), []);
});
