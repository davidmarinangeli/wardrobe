import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import sharp from "sharp";
import test from "node:test";

import { inspoApi } from "../scripts/inspo-api.mjs";
import { wishlistApi } from "../scripts/wishlist-api.mjs";

async function middlewareFor(plugin, root) {
  let middleware;
  await plugin.configResolved({ root });
  plugin.configureServer({ middlewares: { use(handler) { middleware = handler; } } });
  return middleware;
}

async function request(middleware, url, method = "GET") {
  const req = Readable.from([]);
  req.url = url;
  req.method = method;
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body = Buffer.alloc(0)) { this.body = body; },
  };
  await middleware(req, response, () => { response.statusCode = 404; response.end(); });
  return { status: response.statusCode, headers: response.headers, body: Buffer.from(response.body || "") };
}

test("Inspo and Wishlist serve nested assets with their real MIME and reject linked files", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "wardrobe-inspo-wishlist-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const outsideDir = path.join(root, "outside");
  await mkdir(outsideDir, { recursive: true });
  const inspoAsset = path.join(dataDir, "inspo-assets", "nested", "reference.webp");
  const wishlistAsset = path.join(dataDir, "wishlist-assets", "nested", "crop.jpg");
  await mkdir(path.dirname(inspoAsset), { recursive: true });
  await mkdir(path.dirname(wishlistAsset), { recursive: true });
  const webp = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#285078" } }).webp().toBuffer();
  const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#785028" } }).jpeg().toBuffer();
  await writeFile(inspoAsset, webp);
  await writeFile(wishlistAsset, jpeg);

  const linkedTarget = path.join(outsideDir, "private.png");
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#503078" } }).png().toBuffer();
  await writeFile(linkedTarget, png);
  const linkedInspo = path.join(dataDir, "inspo-assets", "nested", "linked.png");
  const linkedWishlist = path.join(dataDir, "wishlist-assets", "nested", "linked.png");
  await symlink(linkedTarget, linkedInspo);
  await symlink(linkedTarget, linkedWishlist);

  const inspoId = "inspo-11111111-1111-4111-8111-111111111111";
  const wishlistId = "wishlist-22222222-2222-4222-8222-222222222222";
  await writeFile(path.join(dataDir, "inspo.json"), JSON.stringify([
    { id: inspoId, name: "Nested source", image: "/api/inspo/assets/nested/reference.webp" },
    { id: "inspo-33333333-3333-4333-8333-333333333333", image: "/api/inspo/assets/nested/linked.png" },
  ]));
  await writeFile(path.join(dataDir, "wishlist.json"), JSON.stringify([
    { id: wishlistId, name: "Nested crop", part: "upperbody", cropImage: "/api/wishlist/assets/nested/crop.jpg", image: "/api/wishlist/assets/nested/crop.jpg" },
    { id: "wishlist-44444444-4444-4444-8444-444444444444", cropImage: "/api/wishlist/assets/nested/linked.png", image: "/api/wishlist/assets/nested/linked.png" },
  ]));

  const env = { WARDROBE_DATA_DIR: "data" };
  const inspo = await middlewareFor(inspoApi({ env }), root);
  const wishlist = await middlewareFor(wishlistApi({ env }), root);
  const sourceResponse = await request(inspo, "/api/inspo/assets/nested/reference.webp");
  assert.equal(sourceResponse.status, 200);
  assert.equal(sourceResponse.headers["content-type"], "image/webp");
  assert.deepEqual(sourceResponse.body, webp);
  const cropResponse = await request(wishlist, "/api/wishlist/assets/nested/crop.jpg");
  assert.equal(cropResponse.status, 200);
  assert.equal(cropResponse.headers["content-type"], "image/jpeg");
  assert.deepEqual(cropResponse.body, jpeg);

  assert.equal((await request(inspo, "/api/inspo/assets/nested/linked.png")).status, 400);
  assert.equal((await request(wishlist, "/api/wishlist/assets/nested/linked.png")).status, 400);
  assert.equal((await request(inspo, `/api/inspo/${"inspo-33333333-3333-4333-8333-333333333333"}`, "DELETE")).status, 400);
  assert.equal((await request(wishlist, "/api/wishlist/wishlist-44444444-4444-4444-8444-444444444444", "DELETE")).status, 400);
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "inspo.json"), "utf8")).length, 2, "a rejected linked-file deletion keeps its catalog record");
  assert.equal(JSON.parse(await readFile(path.join(dataDir, "wishlist.json"), "utf8")).length, 2, "a rejected linked-file deletion keeps its catalog record");

  assert.equal((await request(inspo, `/api/inspo/${inspoId}`, "DELETE")).status, 200);
  assert.equal((await request(wishlist, `/api/wishlist/${wishlistId}`, "DELETE")).status, 200);
  await assert.rejects(readFile(inspoAsset), { code: "ENOENT" });
  await assert.rejects(readFile(wishlistAsset), { code: "ENOENT" });
  await readFile(linkedTarget);
});
