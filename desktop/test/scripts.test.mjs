// Tests for the desktop build scripts. No network: fetch-node is covered
// through its pure helpers, install-native through the pruning step.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { bundleServer } from "../scripts/bundle-server.mjs";
import {
  DESKTOP_DIR, ESBUILD_EXTERNALS, NATIVE_PACKAGES, REPO_ROOT, TARGETS, hostTarget, nativeDependencyVersions, nodeArchive,
  nodeBinaryPath, parseShasums, pruneNativeModules, readAppVersion, readNodeVersion, serverPackageJson, targetFromArgv, targetInfo,
} from "../scripts/common.mjs";

test("targets map to npm and nodejs.org names", () => {
  assert.deepEqual(Object.keys(TARGETS).sort(), ["aarch64-apple-darwin", "x86_64-pc-windows-msvc"]);
  assert.equal(hostTarget("darwin", "arm64"), "aarch64-apple-darwin");
  assert.equal(hostTarget("win32", "x64"), "x86_64-pc-windows-msvc");
  assert.throws(() => hostTarget("linux", "x64"), /No desktop target/);
  assert.throws(() => hostTarget("darwin", "x64"), /No desktop target/);
  assert.equal(targetFromArgv(["--target", "aarch64-apple-darwin"]).os, "darwin");
  assert.equal(targetFromArgv(["--target=x86_64-pc-windows-msvc"]).cpu, "x64");
  assert.throws(() => targetFromArgv(["--target", "x86_64-unknown-linux-gnu"]), /Unsupported target/);
  assert.throws(() => targetFromArgv(["--target"]), /needs a value/);
  assert.match(nodeBinaryPath("x86_64-pc-windows-msvc"), /binaries[\\/]node-x86_64-pc-windows-msvc\.exe$/);
  assert.match(nodeBinaryPath("aarch64-apple-darwin"), /binaries[\\/]node-aarch64-apple-darwin$/);
});

test("the pinned Node version is one Node 24 release", () => {
  const version = readNodeVersion();
  assert.match(version, /^24\.\d+\.\d+$/);
  assert.deepEqual(nodeArchive(version, "aarch64-apple-darwin"), {
    base: `node-v${version}-darwin-arm64`,
    file: `node-v${version}-darwin-arm64.tar.gz`,
    url: `https://nodejs.org/dist/v${version}/node-v${version}-darwin-arm64.tar.gz`,
    shasumsUrl: `https://nodejs.org/dist/v${version}/SHASUMS256.txt`,
    member: `node-v${version}-darwin-arm64/bin/node`,
  });
  assert.equal(nodeArchive(version, "x86_64-pc-windows-msvc").member, `node-v${version}-win-x64/node.exe`);
  assert.equal(nodeArchive(version, "x86_64-pc-windows-msvc").file, `node-v${version}-win-x64.zip`);
});

test("SHASUMS256.txt parsing", () => {
  const a = "a".repeat(64);
  const b = "B".repeat(64);
  const sums = parseShasums(`${a}  node-v24.1.0-win-x64.zip\n${b} *node-v24.1.0-darwin-arm64.tar.gz\r\nnot a line\n`);
  assert.equal(sums.get("node-v24.1.0-win-x64.zip"), a);
  assert.equal(sums.get("node-v24.1.0-darwin-arm64.tar.gz"), "b".repeat(64));
  assert.equal(sums.size, 2);
});

test("the server package.json pins the root lockfile versions", () => {
  const lock = { packages: Object.fromEntries(NATIVE_PACKAGES.map((name, i) => [`node_modules/${name}`, { version: `1.${i}.0` }])) };
  const versions = nativeDependencyVersions(lock);
  assert.deepEqual(Object.keys(versions), [...NATIVE_PACKAGES]);
  assert.equal(versions.sharp, "1.0.0");
  assert.throws(() => nativeDependencyVersions({ packages: {} }), /not in the root package-lock/);
  const real = nativeDependencyVersions();
  for (const name of NATIVE_PACKAGES) assert.match(real[name], /^\d+\.\d+\.\d+/);
  const pkg = serverPackageJson({ appVersion: "1.2.3", dependencies: real });
  assert.equal(pkg.version, "1.2.3");
  assert.equal(pkg.main, "server.cjs");
  assert.deepEqual(pkg.dependencies, real);
  for (const name of NATIVE_PACKAGES) assert.ok(ESBUILD_EXTERNALS.includes(name));
  assert.ok(ESBUILD_EXTERNALS.includes("@img/*"));
});

test("pruning keeps only the target's onnxruntime binaries", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "wardrobe-prune-"));
  try {
    const napi = path.join(dir, "onnxruntime-node", "bin", "napi-v6");
    for (const folder of ["darwin/arm64", "linux/x64", "linux/arm64", "win32/x64", "win32/arm64"]) {
      await mkdir(path.join(napi, ...folder.split("/")), { recursive: true });
      await writeFile(path.join(napi, ...folder.split("/"), "onnxruntime_binding.node"), "x");
    }
    await mkdir(path.join(dir, "onnxruntime-web", "dist"), { recursive: true });
    await mkdir(path.join(dir, ".bin"), { recursive: true });
    await mkdir(path.join(dir, "sharp"), { recursive: true });
    const removed = await pruneNativeModules(dir, "x86_64-pc-windows-msvc");
    assert.deepEqual(await readdir(napi), ["win32"]);
    assert.deepEqual(await readdir(path.join(napi, "win32")), ["x64"]);
    assert.ok(removed.includes("onnxruntime-web"));
    assert.ok(removed.includes("onnxruntime-node/bin/napi-v6/linux"));
    assert.deepEqual((await readdir(dir)).sort(), ["onnxruntime-node", "sharp"]);

    await mkdir(path.join(napi, "darwin", "arm64"), { recursive: true });
    await pruneNativeModules(dir, "aarch64-apple-darwin");
    assert.deepEqual(await readdir(napi), ["darwin"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function runNode(args, { cwd, env, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes("READY\n") && input) { const once = input; input = null; once(child, stdout); }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => resolve({ code, stdout, stderr }));
  });
}

// The bundle is written inside desktop/ so its external packages resolve from
// the repo's node_modules, like resources/server/node_modules in the app.
test("the CommonJS bundle starts with --root and reports the defined version", { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(path.join(DESKTOP_DIR, ".test-bundle-"));
  const work = await mkdtemp(path.join(os.tmpdir(), "wardrobe-bundle-"));
  try {
    const result = await bundleServer({ outDir, version: "9.8.7-test" });
    assert.deepEqual(result.externals, ["@huggingface/transformers", "ipx", "sharp"]);
    const dist = path.join(work, "dist");
    await mkdir(dist, { recursive: true });
    await writeFile(path.join(dist, "index.html"), "<!doctype html><div id=\"root\"></div>");
    const env = { ...process.env, WARDROBE_MANAGED_CONFIG: "1" };
    delete env.NODE_OPTIONS;
    delete env.WARDROBE_DATA_DIR;
    delete env.WARDROBE_CACHE_DIR;
    let health = null;
    const run = await runNode([
      path.join(outDir, "server.cjs"), "--port", "0", "--root", outDir, "--dist", dist,
      "--data-dir", path.join(work, "data"), "--cache-dir", path.join(work, "cache"), "--watch-stdin", "on",
    ], {
      cwd: work,
      env,
      input: async (child, stdout) => {
        const url = /listening on (\S+)/.exec(stdout)[1];
        try {
          health = await (await fetch(`${url}/api/health`)).json();
        } finally {
          child.stdin.end();
        }
      },
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(health.version, "9.8.7-test");
    assert.equal(health.managed, true);
    assert.equal(path.resolve(health.dataDir), path.join(work, "data"));
    assert.equal(path.resolve(health.cacheDir), path.join(work, "cache"));
    // Nothing was written next to the bundle (the install root stays read-only).
    const written = (await readdir(outDir)).sort();
    assert.ok(written.includes("server.cjs") && written.includes("server.cjs.map"), written.join(", "));
    assert.deepEqual(written.filter((name) => !name.startsWith("server.cjs")), []);
  } finally {
    await rm(outDir, { recursive: true, force: true });
    await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test("the app version comes from the root package.json", () => {
  assert.match(readAppVersion(), /^\d+\.\d+\.\d+/);
  assert.equal(readAppVersion(REPO_ROOT), readAppVersion());
  assert.equal(targetInfo("aarch64-apple-darwin").exe, "");
});
