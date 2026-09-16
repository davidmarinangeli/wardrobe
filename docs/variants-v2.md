# Wardrobe data model v2

Wardrobe v2 separates a physical item from the ways it is worn. A library
record keeps common metadata (`part`, colour and identity) and has one or more
`variants`. Each variant has its own `cutout` and optional `modeledPhoto`, an
`origin` (`photo` or `generated`), `sourceRefs`, approval state and an
`assetRevision`. `defaultVariantId` is the presentation used by the gallery;
the gallery still renders one card per physical item.

```json
{
  "schemaVersion": 2,
  "id": "import-…",
  "defaultVariantId": "import-…-standard",
  "variants": [{
    "id": "import-…-rolled-sleeves",
    "name": "Rolled sleeves",
    "description": "Sleeves folded above the elbow",
    "origin": "generated",
    "sourceRefs": ["import-…-standard"],
    "cutout": { "image": "/api/import/library/…-garment.png", "revision": 1, "status": "current" },
    "modeledPhoto": { "image": "/api/import/library/…-modeled.png", "status": "approved", "revision": 1, "sourceRevision": 1 },
    "approvalStatus": "approved",
    "assetRevision": 1
  }],
  "references": [{
    "id": "…-reference-1", "asset": "/api/import/library/…-source.png",
    "role": "view", "scope": "item", "label": "Front view", "distinctive": false, "revision": 1
  }]
}
```

Saved outfits use canonical `pieces: [{ itemId, variantId }]`. The old
`itemIds` field is retained as a read projection so legacy clients and cached
data remain readable. `scripts/wardrobe-data.mjs` performs an idempotent
migration, writing `library.json.v1-backup.json` and
`outfits.json.v1-backup.json` once before changing data.

## API

- `PATCH /api/wardrobe/items/:itemId` edits common metadata.
- `GET|POST /api/wardrobe/items/:itemId/variants` lists or creates variants.
- `PATCH|DELETE /api/wardrobe/items/:itemId/variants/:variantId` edits or
  removes one. A used/default/last variant requires
  `replacementVariantId`; outfit references are replaced in the same update.
- `POST /api/wardrobe/items/:itemId/variants/:variantId/modeled` generates a
  photo from that cutout and the distinctive references relevant to it.
- `PUT /api/wardrobe/items/:itemId/default-variant` (or
  `/variants/:variantId/default`) selects the gallery presentation.
- `GET|POST /api/wardrobe/items/:itemId/references` and `PATCH|DELETE` on a
  reference manage source evidence. Changing one marks linked assets stale.

The frontend exposes the variant shelf in the item detail and a required
variant choice for every multi-variant item in the outfit builder.

## Bulk import

The importer supports a reviewable two-phase flow:

```bash
npm run bulk-import -- --input ~/Pictures/outfits --prepare --manifest /tmp/wardrobe/manifest.json
# edit statuses and review assets under /tmp/wardrobe/items and /tmp/wardrobe/modeled
npm run bulk-import -- --apply --manifest /tmp/wardrobe/manifest.json
```

`--apply` imports only `status: "accepted"` records, derives deterministic
physical IDs from cutout content, and is safe to retry after a partial failure.
