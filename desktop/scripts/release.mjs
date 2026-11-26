#!/usr/bin/env node
/**
 * Release helpers for .github/workflows/release.yml (Feature 05). Plain Node,
 * no dependencies: the `verify` job runs it before `npm ci`.
 *
 *   node desktop/scripts/release.mjs check --tag v1.2.0
 *       The tag equals v<root package.json version>, and the Tauri config is
 *       release-ready (version source, bundle targets, ad-hoc signing, updater
 *       public key, release overlay). Exit 1 with every problem listed.
 *
 *   node desktop/scripts/release.mjs draft --tag v1.2.0 [--repo owner/name]
 *       Finds the draft release for the tag or creates it ("Wardrobe v1.2.0"),
 *       prints its id and writes `release_id=<id>` to $GITHUB_OUTPUT. Refuses a
 *       tag whose release is already published.
 *
 *   node desktop/scripts/release.mjs latest-json --tag v1.2.0 [--repo owner/name]
 *       [--release-id N] [--upload] [--verify-artifacts] [--out file]
 *       Rebuilds latest.json from the release's assets (the .sig files and the
 *       updater artifacts they sign) and the release body as notes, validates it
 *       against the committed public key, and with --upload replaces the
 *       release's latest.json. --verify-artifacts also downloads the updater
 *       artifacts and checks their signatures in full. Run it again after
 *       editing the release notes so the updater shows them.
 *
 * GitHub access uses GH_TOKEN or GITHUB_TOKEN, else `gh auth token`.
 */
import { execFileSync } from "node:child_process";
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { createReadStream } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT, TAURI_DIR, isMain, log, readAppVersion } from "./common.mjs";

export const DEFAULT_REPO = "davidmarinangeli/wardrobe";
export const TAURI_CONFIG = path.join(TAURI_DIR, "tauri.conf.json");
export const RELEASE_OVERLAY = path.join(TAURI_DIR, "tauri.release.conf.json");

/**
 * The updater platforms every release must carry, keyed as in latest.json.
 * `asset` matches the uploaded updater artifact (tauri-action renames the macOS
 * archive to Wardrobe_aarch64.app.tar.gz); `bundle` is the installer type used
 * for the `{os}-{arch}-{bundle}` key the updater plugin also understands.
 */
export const UPDATER_PLATFORMS = Object.freeze({
  "darwin-aarch64": Object.freeze({ bundle: "app", asset: /_aarch64\.app\.tar\.gz$/, file: /\.app\.tar\.gz$/ }),
  "windows-x86_64": Object.freeze({ bundle: "nsis", asset: /_x64-setup\.exe$/, file: /_x64-setup\.exe$/ }),
});

/** The address the installed app polls (tauri.conf.json plugins.updater.endpoints). */
export function updaterEndpoint(repo = DEFAULT_REPO) {
  return `https://github.com/${repo}/releases/latest/download/latest.json`;
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// ---------------------------------------------------------------------------
// Tag and configuration checks

/** The problems with releasing `tag` for package version `version` (empty when fine). */
export function tagProblems(tag, version) {
  const problems = [];
  if (!SEMVER.test(String(version))) problems.push(`package.json version ${JSON.stringify(version)} is not a semantic version`);
  const expected = `v${version}`;
  if (tag !== expected) problems.push(`tag ${JSON.stringify(tag)} does not match package.json: expected ${expected}`);
  return problems;
}

/** The problems that make the Tauri config unfit for a release (empty when fine). */
export function configProblems(config, overlay) {
  const problems = [];
  if (config.version !== "../../package.json") problems.push(`tauri.conf.json version must be "../../package.json" (the root package.json is the single version source), got ${JSON.stringify(config.version)}`);
  const targets = config.bundle?.targets;
  const list = Array.isArray(targets) ? targets : [targets];
  for (const required of ["app", "dmg", "nsis"]) {
    if (!list.includes(required)) problems.push(`bundle.targets must include "${required}"`);
  }
  if (list.includes("msi") || targets === "all") problems.push("bundle.targets must not build an MSI");
  if (config.bundle?.macOS?.signingIdentity !== "-") problems.push(`bundle.macOS.signingIdentity must be "-" (ad-hoc), got ${JSON.stringify(config.bundle?.macOS?.signingIdentity)}`);
  if (config.bundle?.macOS?.hardenedRuntime !== false) problems.push("bundle.macOS.hardenedRuntime must be false: the ad-hoc signed Node sidecar needs JIT, which the hardened runtime forbids without entitlements");
  if (config.bundle?.createUpdaterArtifacts) problems.push("bundle.createUpdaterArtifacts belongs in tauri.release.conf.json, so local builds without the signing key keep working");
  if (overlay?.bundle?.createUpdaterArtifacts !== true) problems.push("tauri.release.conf.json must set bundle.createUpdaterArtifacts to true");
  const updater = config.plugins?.updater ?? {};
  const endpoints = updater.endpoints;
  if (!Array.isArray(endpoints) || endpoints.length !== 1 || endpoints[0] !== updaterEndpoint()) {
    problems.push(`plugins.updater.endpoints must be ["${updaterEndpoint()}"], the latest.json this workflow publishes, got ${JSON.stringify(endpoints)}`);
  }
  if (updater.requireSignedVersion !== true) problems.push("plugins.updater.requireSignedVersion must be true: the signature then pins the version latest.json announces (no downgrade to an older signed build)");
  const pubkey = updater.pubkey;
  if (!pubkey) {
    problems.push("plugins.updater.pubkey is empty: generate the updater keypair (desktop/README.md, \"Updater signing key\") and commit the public key");
  } else {
    try {
      parsePublicKey(pubkey);
    } catch (error) {
      problems.push(`plugins.updater.pubkey is not a minisign public key: ${error.message}`);
    }
  }
  return problems;
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

export async function checkRelease({ tag, root = REPO_ROOT, configFile = TAURI_CONFIG, overlayFile = RELEASE_OVERLAY } = {}) {
  const version = readAppVersion(root);
  const problems = [...tagProblems(tag, version), ...configProblems(await readJson(configFile), await readJson(overlayFile))];
  return { version, problems };
}

// ---------------------------------------------------------------------------
// minisign, as used by the Tauri updater (keys and .sig files are base64 of
// the minisign text files)

function decodeText(b64, what) {
  const text = Buffer.from(String(b64).trim(), "base64").toString("utf8");
  if (!text.startsWith("untrusted comment:")) throw new Error(`${what} does not decode to a minisign file`);
  return text.split(/\r?\n/);
}

/** `{ keyId (hex, as minisign prints it), key (32 raw bytes) }` from a Tauri public key. */
export function parsePublicKey(b64) {
  const lines = decodeText(b64, "the public key");
  const raw = Buffer.from(lines[1] ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString("latin1") !== "Ed") throw new Error("the public key is not an Ed25519 minisign key");
  return { keyId: keyIdHex(raw.subarray(2, 10)), key: raw.subarray(10, 42) };
}

/** The parts of a Tauri `.sig` file (the file content, base64). */
export function parseSignature(b64) {
  const lines = decodeText(b64, "the signature");
  const raw = Buffer.from(lines[1] ?? "", "base64");
  const algorithm = raw.subarray(0, 2).toString("latin1");
  if (raw.length !== 74 || (algorithm !== "ED" && algorithm !== "Ed")) throw new Error("the signature is not an Ed25519 minisign signature");
  const trusted = /^trusted comment: (.*)$/.exec(lines[2] ?? "");
  if (!trusted) throw new Error("the signature has no trusted comment");
  const globalSignature = Buffer.from(lines[3] ?? "", "base64");
  if (globalSignature.length !== 64) throw new Error("the signature has no global signature");
  return {
    prehashed: algorithm === "ED",
    keyId: keyIdHex(raw.subarray(2, 10)),
    signature: raw.subarray(10, 74),
    trustedComment: trusted[1],
    globalSignature,
  };
}

/** `timestamp:…\tfile:…\tversion:…` → `{ timestamp, file, version }`. */
export function trustedCommentFields(comment) {
  const fields = {};
  for (const part of comment.split("\t")) {
    const index = part.indexOf(":");
    if (index > 0) fields[part.slice(0, index)] = part.slice(index + 1);
  }
  return fields;
}

function keyIdHex(bytes) {
  // minisign prints the little-endian key id as a hex number.
  return Buffer.from(bytes).reverse().toString("hex").toUpperCase();
}

function ed25519Key(raw) {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(raw).toString("base64url") }, format: "jwk" });
}

/**
 * Checks a parsed signature against a parsed public key: the key id, the global
 * signature over the trusted comment, and, when `digest` (BLAKE2b-512 of the
 * file, for prehashed signatures) or `data` is given, the file signature.
 * Returns the problems found (empty when it verifies).
 */
export function signatureProblems(signature, publicKey, { digest, data } = {}) {
  if (signature.keyId !== publicKey.keyId) return [`signed by key ${signature.keyId}, but the committed public key is ${publicKey.keyId}`];
  const key = ed25519Key(publicKey.key);
  const problems = [];
  const global = Buffer.concat([signature.signature, Buffer.from(signature.trustedComment, "utf8")]);
  if (!cryptoVerify(null, global, key, signature.globalSignature)) problems.push("the trusted comment's global signature does not verify");
  if (digest || data) {
    let message = data;
    if (signature.prehashed) message = digest ?? createHash("blake2b512").update(data).digest();
    else if (!message) problems.push("a legacy (non-prehashed) signature needs the file data");
    if (message && !cryptoVerify(null, message, key, signature.signature)) problems.push("the file signature does not verify");
  }
  return problems;
}

/** BLAKE2b-512 of a file, streamed. */
export function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("blake2b512");
    createReadStream(file).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest()));
  });
}

// ---------------------------------------------------------------------------
// latest.json

export function assetUrl(repo, tag, name) {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`;
}

/**
 * The updater artifact and its signature asset for each required platform.
 * Throws when an artifact or its .sig is missing or ambiguous.
 */
export function pickUpdaterAssets(assets) {
  const picked = {};
  const missing = [];
  for (const [platform, spec] of Object.entries(UPDATER_PLATFORMS)) {
    const matches = assets.filter((asset) => spec.asset.test(asset.name));
    if (matches.length !== 1) {
      missing.push(`${platform}: ${matches.length === 0 ? "no" : "more than one"} asset matching ${spec.asset}`);
      continue;
    }
    const artifact = matches[0];
    const sig = assets.find((asset) => asset.name === `${artifact.name}.sig`);
    if (!sig) {
      missing.push(`${platform}: ${artifact.name}.sig is missing`);
      continue;
    }
    picked[platform] = { artifact, sig };
  }
  if (missing.length) throw new Error(`the release is missing updater assets:\n  ${missing.join("\n  ")}`);
  return picked;
}

/**
 * latest.json in the shape tauri-action writes: `{os}-{arch}` plus
 * `{os}-{arch}-{bundle}` for each platform. `signatures` maps a platform to the
 * content of its .sig asset.
 */
export function buildLatestJson({ version, notes = "", pubDate, repo, tag, picked, signatures }) {
  const platforms = {};
  for (const [platform, { artifact }] of Object.entries(picked)) {
    const entry = { signature: signatures[platform], url: assetUrl(repo, tag, artifact.name) };
    platforms[platform] = entry;
    platforms[`${platform}-${UPDATER_PLATFORMS[platform].bundle}`] = { ...entry };
  }
  return { version, notes, pub_date: pubDate, platforms };
}

/**
 * Validates latest.json: version, both platforms, URLs on the tag, and each
 * signature against the public key and the release version. `digests` maps a
 * platform to the BLAKE2b-512 of the downloaded artifact for a full check.
 */
export function latestJsonProblems(json, { version, repo, tag, publicKey, digests = {} }) {
  const problems = [];
  if (json?.version !== version) problems.push(`version is ${JSON.stringify(json?.version)}, expected ${version}`);
  if (Number.isNaN(Date.parse(json?.pub_date))) problems.push("pub_date is not a date");
  if (typeof json?.notes !== "string") problems.push("notes is not a string");
  const prefix = `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/`;
  for (const [platform, spec] of Object.entries(UPDATER_PLATFORMS)) {
    for (const key of [platform, `${platform}-${spec.bundle}`]) {
      const entry = json?.platforms?.[key];
      if (!entry) { problems.push(`${key}: missing`); continue; }
      if (typeof entry.url !== "string" || !entry.url.startsWith(prefix) || !spec.asset.test(decodeURIComponent(entry.url.slice(prefix.length)))) {
        problems.push(`${key}: url ${JSON.stringify(entry.url)} is not the platform's asset on ${tag}`);
      }
      let signature;
      try {
        signature = parseSignature(entry.signature);
      } catch (error) {
        problems.push(`${key}: ${error.message}`);
        continue;
      }
      const fields = trustedCommentFields(signature.trustedComment);
      if (fields.version !== undefined && fields.version !== version) problems.push(`${key}: signed for version ${fields.version}, expected ${version}`);
      if (fields.file !== undefined && !spec.file.test(fields.file)) problems.push(`${key}: signed file ${fields.file} is not the platform's updater artifact`);
      if (publicKey) {
        for (const problem of signatureProblems(signature, publicKey, { digest: digests[platform] })) problems.push(`${key}: ${problem}`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// GitHub

function githubToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("No GitHub token: set GH_TOKEN or GITHUB_TOKEN, or log in with `gh auth login`.");
  }
}

/** A minimal GitHub REST client over fetch. Tests pass a fake with the same methods. */
export function githubClient({ repo, token = githubToken(), api = "https://api.github.com", uploads = "https://uploads.github.com" }) {
  const headers = { authorization: `Bearer ${token}`, "x-github-api-version": "2022-11-28", "user-agent": "wardrobe-release-script" };
  async function call(method, url, { body, accept = "application/vnd.github+json", contentType } = {}) {
    const response = await fetch(url, {
      method,
      headers: { ...headers, accept, ...(contentType ? { "content-type": contentType } : {}) },
      body,
    });
    if (!response.ok) throw new Error(`${method} ${url} failed: ${response.status} ${await response.text()}`);
    return response;
  }
  return {
    repo,
    async listReleases() {
      const releases = [];
      for (let page = 1; ; page++) {
        const batch = await (await call("GET", `${api}/repos/${repo}/releases?per_page=100&page=${page}`)).json();
        releases.push(...batch);
        if (batch.length < 100) return releases;
      }
    },
    async getRelease(id) {
      return (await call("GET", `${api}/repos/${repo}/releases/${id}`)).json();
    },
    async createRelease(body) {
      return (await call("POST", `${api}/repos/${repo}/releases`, { body: JSON.stringify(body), contentType: "application/json" })).json();
    },
    async listAssets(id) {
      const assets = [];
      for (let page = 1; ; page++) {
        const batch = await (await call("GET", `${api}/repos/${repo}/releases/${id}/assets?per_page=100&page=${page}`)).json();
        assets.push(...batch);
        if (batch.length < 100) return assets;
      }
    },
    async downloadAsset(assetId) {
      // Follows the redirect to the storage host; fetch drops the token on that cross-origin hop.
      return Buffer.from(await (await call("GET", `${api}/repos/${repo}/releases/assets/${assetId}`, { accept: "application/octet-stream" })).arrayBuffer());
    },
    async deleteAsset(assetId) {
      await call("DELETE", `${api}/repos/${repo}/releases/assets/${assetId}`);
    },
    async uploadAsset(id, name, data, contentType = "application/json") {
      return (await call("POST", `${uploads}/repos/${repo}/releases/${id}/assets?name=${encodeURIComponent(name)}`, { body: data, contentType })).json();
    },
  };
}

/** The draft release for `tag`, created when there is none. Refuses a published one. */
export async function findOrCreateDraft(github, tag) {
  const existing = (await github.listReleases()).filter((release) => release.tag_name === tag);
  const published = existing.find((release) => !release.draft);
  if (published) throw new Error(`release ${tag} is already published (${published.html_url}); bump the version instead of rebuilding it`);
  if (existing.length > 1) throw new Error(`there are ${existing.length} draft releases for ${tag}; delete the extra ones and re-run`);
  if (existing.length === 1) return { release: existing[0], created: false };
  const release = await github.createRelease({ tag_name: tag, name: `Wardrobe ${tag}`, body: "", draft: true, prerelease: false });
  return { release, created: true };
}

async function releaseFor(github, tag, releaseId) {
  if (releaseId) {
    const release = await github.getRelease(releaseId);
    if (release.tag_name !== tag) throw new Error(`release ${releaseId} is for ${release.tag_name}, not ${tag}`);
    return release;
  }
  const matches = (await github.listReleases()).filter((release) => release.tag_name === tag);
  if (matches.length !== 1) throw new Error(`expected one release for ${tag}, found ${matches.length}`);
  return matches[0];
}

/**
 * Rebuilds, validates and optionally uploads latest.json for a release.
 * Returns `{ json, problems, uploaded }`; nothing is uploaded when there are problems.
 */
export async function refreshLatestJson(github, { tag, releaseId, version, publicKey, upload = false, verifyArtifacts = false, now = new Date() }) {
  const release = await releaseFor(github, tag, releaseId);
  const assets = await github.listAssets(release.id);
  const picked = pickUpdaterAssets(assets);
  const signatures = {};
  const digests = {};
  let work = null;
  try {
    for (const [platform, { artifact, sig }] of Object.entries(picked)) {
      signatures[platform] = (await github.downloadAsset(sig.id)).toString("utf8").trim();
      if (verifyArtifacts) {
        work ??= await mkdtemp(path.join(os.tmpdir(), "wardrobe-release-"));
        const file = path.join(work, artifact.name);
        await writeFile(file, await github.downloadAsset(artifact.id));
        digests[platform] = await hashFile(file);
      }
    }
  } finally {
    if (work) await rm(work, { recursive: true, force: true });
  }
  const json = buildLatestJson({
    version, notes: release.body ?? "", pubDate: now.toISOString(), repo: github.repo, tag, picked, signatures,
  });
  const problems = latestJsonProblems(json, { version, repo: github.repo, tag, publicKey, digests });
  let uploaded = false;
  if (upload && problems.length === 0) {
    for (const asset of assets.filter((a) => a.name === "latest.json")) await github.deleteAsset(asset.id);
    await github.uploadAsset(release.id, "latest.json", Buffer.from(`${JSON.stringify(json, null, 2)}\n`));
    uploaded = true;
  }
  return { json, problems, uploaded, release };
}

// ---------------------------------------------------------------------------
// CLI

function option(argv, name) {
  const index = argv.indexOf(`--${name}`);
  if (index >= 0) {
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`--${name} needs a value`);
    return value;
  }
  const inline = argv.find((arg) => arg.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : undefined;
}

function requireTag(argv) {
  const tag = option(argv, "tag");
  if (!tag) throw new Error("--tag is required (for example --tag v1.2.0)");
  return tag.replace(/^refs\/tags\//, "");
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === "check") {
    const tag = requireTag(rest);
    const { version, problems } = await checkRelease({ tag });
    if (problems.length) throw new Error(`cannot release ${tag}:\n  - ${problems.join("\n  - ")}`);
    log(`release check passed: ${tag} = package.json ${version}, Tauri config is release-ready`);
    return;
  }
  if (command === "draft") {
    const tag = requireTag(rest);
    const github = githubClient({ repo: option(rest, "repo") ?? DEFAULT_REPO });
    const { release, created } = await findOrCreateDraft(github, tag);
    log(`${created ? "created" : "reusing"} draft release ${release.id} for ${tag}`);
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `release_id=${release.id}\n`);
    process.stdout.write(`${release.id}\n`);
    return;
  }
  if (command === "latest-json") {
    const tag = requireTag(rest);
    const version = readAppVersion();
    const tagIssues = tagProblems(tag, version);
    if (tagIssues.length) throw new Error(tagIssues.join("; "));
    const config = await readJson(TAURI_CONFIG);
    const publicKey = parsePublicKey(config.plugins?.updater?.pubkey ?? "");
    const github = githubClient({ repo: option(rest, "repo") ?? DEFAULT_REPO });
    const releaseId = option(rest, "release-id");
    const { json, problems, uploaded } = await refreshLatestJson(github, {
      tag, releaseId: releaseId ? Number(releaseId) : undefined, version, publicKey,
      upload: rest.includes("--upload"), verifyArtifacts: rest.includes("--verify-artifacts"),
    });
    const out = option(rest, "out");
    if (out) await writeFile(out, `${JSON.stringify(json, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
    if (problems.length) throw new Error(`latest.json for ${tag} is not valid:\n  - ${problems.join("\n  - ")}`);
    log(`latest.json for ${tag} is valid (${Object.keys(UPDATER_PLATFORMS).join(", ")}, key ${publicKey.keyId})${uploaded ? " and uploaded" : ""}`);
    return;
  }
  throw new Error(`usage: release.mjs check|draft|latest-json --tag v<version> [options]; got ${JSON.stringify(command ?? "")}`);
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`release: ${error?.message || error}\n`);
    process.exit(1);
  });
}
