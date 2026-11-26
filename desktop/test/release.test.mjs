// Tests for the release helpers (desktop/scripts/release.mjs) and the release
// workflow. No network and no real keys: minisign keys and signatures are made
// here with node:crypto in the exact format `tauri signer` writes, and GitHub is
// a fake client.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { DESKTOP_DIR, REPO_ROOT, readAppVersion, targetInfo } from "../scripts/common.mjs";
import {
  RELEASE_OVERLAY, TAURI_CONFIG, UPDATER_PLATFORMS, assetUrl, buildLatestJson, configProblems, findOrCreateDraft,
  latestJsonProblems, parsePublicKey, parseSignature, pickUpdaterAssets, refreshLatestJson, signatureProblems,
  tagProblems, trustedCommentFields,
} from "../scripts/release.mjs";
import { sidecarLayout } from "../scripts/smoke-sidecar.mjs";

const REPO = "owner/wardrobe";
const TAG = "v1.2.3";
const VERSION = "1.2.3";

/** A minisign keypair in Tauri's format: `{ pubkey (base64 file), sign(data, comment) → .sig content }`. */
function makeKey(keyIdBytes = [1, 2, 3, 4, 5, 6, 7, 8]) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
  const keyId = Buffer.from(keyIdBytes);
  const keyIdText = Buffer.from(keyId).reverse().toString("hex").toUpperCase();
  const pubkey = Buffer.from(`untrusted comment: minisign public key: ${keyIdText}\n${Buffer.concat([Buffer.from("Ed"), keyId, raw]).toString("base64")}\n`).toString("base64");
  function sign(data, trustedComment) {
    const digest = createHash("blake2b512").update(data).digest();
    const signature = cryptoSign(null, digest, privateKey);
    const global = cryptoSign(null, Buffer.concat([signature, Buffer.from(trustedComment)]), privateKey);
    const text = `untrusted comment: signature from tauri secret key\n${Buffer.concat([Buffer.from("ED"), keyId, signature]).toString("base64")}\ntrusted comment: ${trustedComment}\n${global.toString("base64")}\n`;
    return Buffer.from(text).toString("base64");
  }
  return { pubkey, keyIdText, sign };
}

const comment = (file, version = VERSION) => `timestamp:1795733428\tfile:${file}\tversion:${version}`;

function releaseConfig(pubkey) {
  return {
    version: "../../package.json",
    bundle: { targets: ["app", "dmg", "nsis"], macOS: { signingIdentity: "-", hardenedRuntime: false } },
    plugins: { updater: { pubkey } },
  };
}
const OVERLAY = { bundle: { createUpdaterArtifacts: true } };

test("the tag must equal v<package.json version>", () => {
  assert.deepEqual(tagProblems("v1.2.3", "1.2.3"), []);
  assert.deepEqual(tagProblems("v0.0.1-rc1", "0.0.1-rc1"), []);
  assert.match(tagProblems("v1.2.4", "1.2.3")[0], /does not match package\.json: expected v1\.2\.3/);
  assert.match(tagProblems("1.2.3", "1.2.3")[0], /expected v1\.2\.3/);
  assert.match(tagProblems("vx", "x")[0], /not a semantic version/);
});

test("the release config check accepts a complete config and names each gap", () => {
  const { pubkey } = makeKey();
  assert.deepEqual(configProblems(releaseConfig(pubkey), OVERLAY), []);

  const broken = releaseConfig("");
  broken.version = "1.0.0";
  broken.bundle.targets = ["app", "nsis", "msi"];
  broken.bundle.macOS = {};
  broken.bundle.createUpdaterArtifacts = true;
  const problems = configProblems(broken, {}).join("\n");
  assert.match(problems, /version must be "\.\.\/\.\.\/package\.json"/);
  assert.match(problems, /must include "dmg"/);
  assert.match(problems, /must not build an MSI/);
  assert.match(problems, /signingIdentity must be "-"/);
  assert.match(problems, /hardenedRuntime must be false/);
  assert.match(problems, /createUpdaterArtifacts belongs in tauri\.release\.conf\.json/);
  assert.match(problems, /tauri\.release\.conf\.json must set bundle\.createUpdaterArtifacts/);
  assert.match(problems, /pubkey is empty/);
  assert.match(configProblems(releaseConfig("bm90IGEga2V5"), OVERLAY).join(), /not a minisign public key/);
});

test("the committed Tauri config is release-ready except, until the owner commits it, the public key", () => {
  const config = JSON.parse(readFileSync(TAURI_CONFIG, "utf8"));
  const overlay = JSON.parse(readFileSync(RELEASE_OVERLAY, "utf8"));
  const problems = configProblems(config, overlay);
  assert.ok(problems.every((problem) => /plugins\.updater\.pubkey/.test(problem)), problems.join("\n"));
  assert.deepEqual(configProblems({ ...config, plugins: { updater: { pubkey: makeKey().pubkey } } }, overlay), []);
  // Local builds must never need the signing key.
  assert.equal(config.bundle.createUpdaterArtifacts, undefined);
  assert.equal(config.version, "../../package.json");
});

test("minisign signatures verify against the matching key only", () => {
  const key = makeKey();
  const other = makeKey([9, 9, 9, 9, 9, 9, 9, 9]);
  const data = Buffer.from("the installer bytes");
  const sig = parseSignature(key.sign(data, comment("Wardrobe_1.2.3_x64-setup.exe")));
  const publicKey = parsePublicKey(key.pubkey);
  assert.equal(publicKey.keyId, key.keyIdText);
  assert.equal(sig.keyId, key.keyIdText);
  assert.equal(sig.prehashed, true);
  assert.deepEqual(trustedCommentFields(sig.trustedComment), { timestamp: "1795733428", file: "Wardrobe_1.2.3_x64-setup.exe", version: VERSION });

  assert.deepEqual(signatureProblems(sig, publicKey), []);
  assert.deepEqual(signatureProblems(sig, publicKey, { data }), []);
  assert.deepEqual(signatureProblems(sig, publicKey, { digest: createHash("blake2b512").update(data).digest() }), []);
  assert.deepEqual(signatureProblems(sig, publicKey, { data: Buffer.from("tampered") }), ["the file signature does not verify"]);
  assert.match(signatureProblems(sig, parsePublicKey(other.pubkey))[0], /signed by key 0807060504030201, but the committed public key is 0909090909090909/);

  // Same key id, different key: the global signature fails.
  const impostor = makeKey();
  assert.deepEqual(signatureProblems(sig, parsePublicKey(impostor.pubkey), { data }), [
    "the trusted comment's global signature does not verify", "the file signature does not verify",
  ]);
  // An edited trusted comment (for example a different version) breaks the global signature.
  assert.deepEqual(signatureProblems({ ...sig, trustedComment: comment("Wardrobe_1.2.3_x64-setup.exe", "9.9.9") }, publicKey), [
    "the trusted comment's global signature does not verify",
  ]);
  assert.throws(() => parseSignature(Buffer.from("hello").toString("base64")), /minisign/);
  assert.throws(() => parsePublicKey(key.sign(data, "x")), /not an Ed25519 minisign key/);
});

/** Assets of a complete release; `extra` adds or replaces by name. */
function releaseAssets(key, { version = VERSION, extra = [] } = {}) {
  const mac = Buffer.from("mac updater archive");
  const win = Buffer.from("windows installer");
  const files = new Map([
    ["Wardrobe_1.2.3_aarch64.dmg", Buffer.from("dmg")],
    ["Wardrobe_aarch64.app.tar.gz", mac],
    ["Wardrobe_aarch64.app.tar.gz.sig", Buffer.from(key.sign(mac, comment("Wardrobe.app.tar.gz", version)))],
    ["Wardrobe_1.2.3_x64-setup.exe", win],
    ["Wardrobe_1.2.3_x64-setup.exe.sig", Buffer.from(key.sign(win, comment("Wardrobe_1.2.3_x64-setup.exe", version)))],
  ]);
  for (const [name, data] of extra) files.set(name, data);
  return [...files].map(([name, data], index) => ({ id: index + 100, name, data }));
}

function fakeGithub({ releases = [], assets = [] } = {}) {
  const calls = [];
  const state = { releases: releases.map((r) => ({ ...r })), assets: [...assets] };
  return {
    repo: REPO,
    calls,
    state,
    async listReleases() { calls.push("listReleases"); return state.releases; },
    async getRelease(id) { calls.push(`getRelease ${id}`); return state.releases.find((r) => r.id === id); },
    async createRelease(body) {
      calls.push(`createRelease ${JSON.stringify(body)}`);
      const release = { id: 7, html_url: "https://example.invalid/r/7", ...body };
      state.releases.push(release);
      return release;
    },
    async listAssets(id) { calls.push(`listAssets ${id}`); return state.assets.map(({ id: assetId, name }) => ({ id: assetId, name })); },
    async downloadAsset(id) { calls.push(`download ${id}`); return state.assets.find((a) => a.id === id).data; },
    async deleteAsset(id) { calls.push(`delete ${id}`); state.assets = state.assets.filter((a) => a.id !== id); },
    async uploadAsset(id, name, data) { calls.push(`upload ${id} ${name}`); state.assets.push({ id: 999, name, data }); return { id: 999 }; },
  };
}

test("updater assets are picked per platform and gaps are reported", () => {
  const key = makeKey();
  const assets = releaseAssets(key);
  const picked = pickUpdaterAssets(assets);
  assert.deepEqual(Object.keys(picked).sort(), Object.keys(UPDATER_PLATFORMS).sort());
  assert.equal(picked["darwin-aarch64"].artifact.name, "Wardrobe_aarch64.app.tar.gz");
  assert.equal(picked["windows-x86_64"].sig.name, "Wardrobe_1.2.3_x64-setup.exe.sig");
  assert.throws(() => pickUpdaterAssets(assets.filter((a) => !a.name.endsWith(".exe.sig"))), /windows-x86_64: Wardrobe_1\.2\.3_x64-setup\.exe\.sig is missing/);
  assert.throws(() => pickUpdaterAssets(assets.filter((a) => !a.name.includes(".app."))), /darwin-aarch64: no asset/);
});

test("latest.json names both platforms with tag URLs and signatures that verify", () => {
  const key = makeKey();
  const assets = releaseAssets(key);
  const picked = pickUpdaterAssets(assets);
  const signatures = Object.fromEntries(Object.entries(picked).map(([p, { sig }]) => [p, sig.data.toString()]));
  const json = buildLatestJson({ version: VERSION, notes: "Notes", pubDate: "2026-11-26T00:00:00.000Z", repo: REPO, tag: TAG, picked, signatures });
  assert.deepEqual(Object.keys(json.platforms).sort(), ["darwin-aarch64", "darwin-aarch64-app", "windows-x86_64", "windows-x86_64-nsis"]);
  assert.equal(json.platforms["darwin-aarch64"].url, "https://github.com/owner/wardrobe/releases/download/v1.2.3/Wardrobe_aarch64.app.tar.gz");
  assert.equal(json.platforms["windows-x86_64"].url, assetUrl(REPO, TAG, "Wardrobe_1.2.3_x64-setup.exe"));
  const publicKey = parsePublicKey(key.pubkey);
  const digests = {
    "darwin-aarch64": createHash("blake2b512").update(picked["darwin-aarch64"].artifact.data).digest(),
    "windows-x86_64": createHash("blake2b512").update(picked["windows-x86_64"].artifact.data).digest(),
  };
  assert.deepEqual(latestJsonProblems(json, { version: VERSION, repo: REPO, tag: TAG, publicKey, digests }), []);

  // A merge that lost a platform (the tauri-action race) is caught.
  const partial = structuredClone(json);
  delete partial.platforms["windows-x86_64"];
  delete partial.platforms["windows-x86_64-nsis"];
  assert.deepEqual(latestJsonProblems(partial, { version: VERSION, repo: REPO, tag: TAG, publicKey }), ["windows-x86_64: missing", "windows-x86_64-nsis: missing"]);

  // An untagged draft URL, a wrong version, a wrong key and a swapped artifact.
  const bad = structuredClone(json);
  bad.platforms["darwin-aarch64"].url = "https://github.com/owner/wardrobe/releases/download/untagged-abc/Wardrobe_aarch64.app.tar.gz";
  const problems = latestJsonProblems(bad, { version: "1.2.4", repo: REPO, tag: TAG, publicKey: parsePublicKey(makeKey([5, 5, 5, 5, 5, 5, 5, 5]).pubkey) });
  assert.ok(problems.includes('version is "1.2.3", expected 1.2.4'), problems.join("\n"));
  assert.ok(problems.some((p) => /^darwin-aarch64: url .*untagged-abc/.test(p)));
  assert.ok(problems.some((p) => /signed for version 1\.2\.3, expected 1\.2\.4/.test(p)));
  assert.ok(problems.some((p) => /signed by key .* but the committed public key is 0505050505050505/.test(p)));
  const swapped = { "windows-x86_64": digests["darwin-aarch64"] };
  assert.deepEqual(latestJsonProblems(json, { version: VERSION, repo: REPO, tag: TAG, publicKey, digests: swapped }), [
    "windows-x86_64: the file signature does not verify", "windows-x86_64-nsis: the file signature does not verify",
  ]);
});

test("the draft release is created once, reused on re-runs and never a published one", async () => {
  const fresh = fakeGithub();
  const created = await findOrCreateDraft(fresh, TAG);
  assert.equal(created.created, true);
  assert.deepEqual(JSON.parse(fresh.calls[1].slice("createRelease ".length)), { tag_name: TAG, name: "Wardrobe v1.2.3", body: "", draft: true, prerelease: false });
  const again = await findOrCreateDraft(fresh, TAG);
  assert.equal(again.created, false);
  assert.equal(again.release.id, 7);

  await assert.rejects(findOrCreateDraft(fakeGithub({ releases: [{ id: 1, tag_name: TAG, draft: false, html_url: "u" }] }), TAG), /already published/);
  await assert.rejects(findOrCreateDraft(fakeGithub({ releases: [{ id: 1, tag_name: TAG, draft: true }, { id: 2, tag_name: TAG, draft: true }] }), TAG), /2 draft releases/);
  const other = await findOrCreateDraft(fakeGithub({ releases: [{ id: 1, tag_name: "v0.9.0", draft: false }] }), TAG);
  assert.equal(other.created, true);
});

test("refreshing latest.json replaces the merged file and verifies the artifacts", async () => {
  const key = makeKey();
  const publicKey = parsePublicKey(key.pubkey);
  const stale = Buffer.from(JSON.stringify({ version: VERSION, platforms: { "darwin-aarch64": {} } }));
  const github = fakeGithub({
    releases: [{ id: 42, tag_name: TAG, draft: true, body: "What's new" }],
    assets: releaseAssets(key, { extra: [["latest.json", stale]] }),
  });
  const staleId = github.state.assets.find((a) => a.name === "latest.json").id;
  const result = await refreshLatestJson(github, {
    tag: TAG, releaseId: 42, version: VERSION, publicKey, upload: true, verifyArtifacts: true, now: new Date("2026-11-26T12:00:00Z"),
  });
  assert.deepEqual(result.problems, []);
  assert.equal(result.uploaded, true);
  assert.equal(result.json.notes, "What's new");
  assert.equal(result.json.pub_date, "2026-11-26T12:00:00.000Z");
  assert.ok(github.calls.includes(`delete ${staleId}`));
  assert.ok(github.calls.includes("upload 42 latest.json"));
  const uploaded = JSON.parse(github.state.assets.find((a) => a.name === "latest.json").data.toString());
  assert.deepEqual(uploaded, result.json);
  // The artifacts themselves were downloaded for the full check.
  for (const name of ["Wardrobe_aarch64.app.tar.gz", "Wardrobe_1.2.3_x64-setup.exe"]) {
    const id = github.state.assets.find((a) => a.name === name).id;
    assert.ok(github.calls.includes(`download ${id}`), name);
  }

  // Signed with another key: nothing is uploaded.
  const wrongKey = fakeGithub({ releases: [{ id: 42, tag_name: TAG, draft: true }], assets: releaseAssets(makeKey([3, 3, 3, 3, 3, 3, 3, 3])) });
  const rejected = await refreshLatestJson(wrongKey, { tag: TAG, releaseId: 42, version: VERSION, publicKey, upload: true });
  assert.equal(rejected.uploaded, false);
  assert.ok(rejected.problems.length > 0);
  assert.ok(!wrongKey.calls.some((call) => call.startsWith("upload")));

  await assert.rejects(refreshLatestJson(fakeGithub({ releases: [{ id: 42, tag_name: "v0.1.0" }] }), { tag: TAG, releaseId: 42, version: VERSION, publicKey }), /is for v0\.1\.0/);
});

test("release.mjs check fails a tag that does not match package.json, before anything is built", () => {
  const version = readAppVersion();
  const result = spawnSync(process.execPath, [path.join(DESKTOP_DIR, "scripts", "release.mjs"), "check", "--tag", `v${version}-not-this`], { encoding: "utf8", cwd: REPO_ROOT });
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`does not match package\\.json: expected v${version.replace(/\./g, "\\.")}`));
  const usage = spawnSync(process.execPath, [path.join(DESKTOP_DIR, "scripts", "release.mjs"), "nope"], { encoding: "utf8" });
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /usage: release\.mjs check\|draft\|latest-json/);
});

test("the smoke test finds the sidecar inside a built app", () => {
  const mac = sidecarLayout({ target: targetInfo("aarch64-apple-darwin"), app: "/tmp/Wardrobe.app" });
  assert.equal(mac.node, path.resolve("/tmp/Wardrobe.app/Contents/MacOS/node"));
  assert.equal(mac.serverDir, path.resolve("/tmp/Wardrobe.app/Contents/Resources/server"));
  assert.equal(mac.webDir, path.resolve("/tmp/Wardrobe.app/Contents/Resources/web"));
  const win = sidecarLayout({ target: targetInfo("x86_64-pc-windows-msvc"), app: "target/release" });
  assert.equal(win.node, path.resolve("target/release/node.exe"));
  assert.equal(win.serverDir, path.resolve("target/release/server"));
  const prepared = sidecarLayout({ target: targetInfo("x86_64-pc-windows-msvc") });
  assert.match(prepared.node, /binaries[\\/]node-x86_64-pc-windows-msvc\.exe$/);
  assert.match(prepared.serverDir, /resources[\\/]server$/);
});

test("release.yml builds both targets from v* tags into a draft with updater artifacts", () => {
  const workflow = readFileSync(path.join(REPO_ROOT, ".github", "workflows", "release.yml"), "utf8");
  for (const expected of [
    /tags:\s*\n\s*- "v\*"/,
    /contents: write/,
    /release\.mjs check --tag "\$TAG"\n\s*env:\n\s*TAG: \$\{\{ github\.ref_name \}\}/,
    /run: npm run check/,
    /os: macos-14\s*\n\s*target: aarch64-apple-darwin\s*\n\s*tauri_args: --target aarch64-apple-darwin/,
    /os: windows-latest\s*\n\s*target: x86_64-pc-windows-msvc/,
    /node-version-file: desktop\/node-version\.txt/,
    /node desktop\/scripts\/prepare\.mjs --target \$\{\{ matrix\.target \}\}/,
    /uses: tauri-apps\/tauri-action@v0/,
    /projectPath: desktop/,
    /releaseDraft: true/,
    /prerelease: false/,
    /includeUpdaterJson: true/,
    /args: --config src-tauri\/tauri\.release\.conf\.json \$\{\{ matrix\.tauri_args \}\}/,
    /TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY \}\}/,
    /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_SIGNING_PRIVATE_KEY_PASSWORD \}\}/,
    /APPLE_SIGNING_IDENTITY: \$\{\{ runner\.os == 'macOS' && '-' \|\| '' \}\}/,
    /grep -q "Signature=adhoc"/,
    /release\.mjs latest-json/,
  ]) assert.match(workflow, expected);
  // The build legs wait for verify, so a wrong tag never builds.
  assert.match(workflow, /build:[\s\S]*?needs: \[verify, draft\]/);
  assert.match(workflow, /finalize:[\s\S]*?needs: \[draft, build\]/);
  // No ${{ github.ref_name }} spliced into a shell script (a tag can hold $(...)).
  for (const line of workflow.split("\n").filter((l) => /^\s*(run:|--)/.test(l))) {
    assert.doesNotMatch(line, /\$\{\{ github\.(ref_name|repository) \}\}/, line);
  }
});
