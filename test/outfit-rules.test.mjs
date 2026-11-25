import test from "node:test";
import assert from "node:assert/strict";
import { blockedCoverages, isPieceBlocked } from "../shared/outfit-rules.mjs";

const piece = (id, part) => ({ id, part });
const dress = piece("dress", "dress");
const jumpsuit = piece("jump", "jumpsuit");
const top = piece("top", "upperbody");
const bodysuit = piece("body", "bodysuit");
const bottom = piece("bottom", "lowerbody");
const skirt = piece("skirt", "skirt");
const shorts = piece("shorts", "shorts");
const jacket = piece("jacket", "wholebody_up");
const shoes = piece("shoes", "shoes");
const hat = piece("hat", "accessories_up");
const pool = [dress, jumpsuit, top, bodysuit, bottom, skirt, shorts, jacket, shoes, hat];
const blockedIds = (selection) => pool.filter((p) => isPieceBlocked(p, blockedCoverages(selection))).map((p) => p.id);

test("a dress or jumpsuit blocks tops and bottoms", () => {
  for (const full of [dress, jumpsuit]) {
    assert.deepEqual(blockedCoverages([full]), new Set(["upper", "lower"]), full.part);
    // A second full piece stays allowed: only the halves are blocked (today's behaviour, not a bug).
    assert.deepEqual(blockedIds([full]), ["top", "body", "bottom", "skirt", "shorts"], full.part);
  }
});

test("a top blocks full-length pieces only", () => {
  for (const upper of [top, bodysuit]) {
    assert.deepEqual(blockedCoverages([upper]), new Set(["full"]), upper.part);
    assert.deepEqual(blockedIds([upper]), ["dress", "jump"], upper.part);
  }
});

test("a bottom, skirt, or shorts blocks full-length pieces only", () => {
  for (const lower of [bottom, skirt, shorts]) {
    assert.deepEqual(blockedCoverages([lower]), new Set(["full"]), lower.part);
    assert.deepEqual(blockedIds([lower]), ["dress", "jump"], lower.part);
  }
});

test("a jacket neither blocks nor is blocked, alongside a dress or a top", () => {
  assert.equal(blockedCoverages([jacket]).size, 0);
  assert.deepEqual(blockedIds([jacket]), []);
  assert.equal(isPieceBlocked(jacket, blockedCoverages([dress])), false);
  assert.equal(isPieceBlocked(jacket, blockedCoverages([top])), false);
  assert.deepEqual(blockedCoverages([jacket, dress]), new Set(["upper", "lower"]));
  assert.deepEqual(blockedCoverages([jacket, top]), new Set(["full"]));
});

test("an empty selection blocks nothing", () => {
  assert.equal(blockedCoverages([]).size, 0);
  assert.equal(blockedCoverages().size, 0);
  assert.deepEqual(blockedIds([]), []);
});

test("an unknown part contributes nothing and is never blocked", () => {
  assert.equal(blockedCoverages([piece("x", "cape")]).size, 0);
  assert.equal(blockedCoverages([{ id: "y" }, null]).size, 0);
  const everything = new Set(["upper", "lower", "full"]);
  assert.equal(isPieceBlocked(piece("x", "cape"), everything), false);
  assert.equal(isPieceBlocked({ id: "y" }, everything), false);
  assert.equal(isPieceBlocked(top, undefined), false);
});

test("shoes and accessories never block and are never blocked", () => {
  assert.equal(blockedCoverages([shoes, hat]).size, 0);
  assert.equal(isPieceBlocked(shoes, blockedCoverages([dress])), false);
  assert.equal(isPieceBlocked(hat, blockedCoverages([top])), false);
});

test("an already-mixed selection lets the full piece win", () => {
  assert.deepEqual(blockedCoverages([dress, top]), new Set(["upper", "lower"]));
});
