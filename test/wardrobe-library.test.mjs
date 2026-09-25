import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { mutateLibrary } from "../shared/wardrobe-library.mjs";

const GRACE_MS = 3 * 60_000;
const oldTime = new Date(Date.now() - GRACE_MS - 5_000);

async function makeDataDir() {
  return mkdtemp(path.join(os.tmpdir(), "wardrobe-library-lock-"));
}

async function ageDirectory(directory) {
  await utimes(directory, oldTime, oldTime);
}

async function assertStillHeldWhileMutationWaits(dataDir, lockDir) {
  let completed = false;
  const pending = mutateLibrary(dataDir, (current) => [...current, { id: "after-release" }])
    .then((result) => { completed = true; return result; });
  await delay(80);
  const completedBeforeRelease = completed;
  const lockStillExists = await stat(lockDir).then(() => true, () => false);
  const libraryBeforeRelease = await readFile(path.join(dataDir, "library.json"), "utf8").then(JSON.parse);
  await rm(lockDir, { recursive: true, force: true });
  await pending;
  assert.equal(completedBeforeRelease, false);
  assert.equal(lockStillExists, true);
  assert.deepEqual(libraryBeforeRelease, []);
}

test("recovers aged lock directories with absent or corrupt owner markers", async (t) => {
  for (const marker of ["absent", "corrupt"]) {
    await t.test(marker, async () => {
      const dataDir = await makeDataDir();
      const lockDir = path.join(dataDir, "library.json.lock");
      try {
        await mkdir(lockDir);
        if (marker === "corrupt") await writeFile(path.join(lockDir, "owner.json"), "{broken");
        await ageDirectory(lockDir);
        const result = await mutateLibrary(dataDir, (current) => [...current, { id: marker }]);
        assert.deepEqual(result, [{ id: marker }]);
        assert.equal(await stat(lockDir).then(() => true, () => false), false);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("keeps recent orphan locks and aged locks owned by a live process", async (t) => {
  for (const marker of ["absent", "corrupt", "live-pid"]) {
    await t.test(marker, async () => {
      const dataDir = await makeDataDir();
      const lockDir = path.join(dataDir, "library.json.lock");
      try {
        await writeFile(path.join(dataDir, "library.json"), "[]\n");
        await mkdir(lockDir);
        if (marker === "corrupt") await writeFile(path.join(lockDir, "owner.json"), "not json");
        if (marker === "live-pid") {
          await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
          await ageDirectory(lockDir);
        }
        await assertStillHeldWhileMutationWaits(dataDir, lockDir);
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("two processes preserve both updates while recovering an orphan lock", { timeout: 15_000 }, async () => {
  const dataDir = await makeDataDir();
  const lockDir = path.join(dataDir, "library.json.lock");
  const moduleUrl = new URL("../shared/wardrobe-library.mjs", import.meta.url).href;
  const worker = `
    import { mutateLibrary } from ${JSON.stringify(moduleUrl)};
    const [dataDir, id] = process.argv.slice(1);
    await mutateLibrary(dataDir, (current) => [...current, { id }]);
  `;
  const runWorker = (id) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", worker, dataDir, id], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Worker ${id} timed out${stderr ? `: ${stderr}` : ""}`));
    }, 8_000);
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`Worker ${id} exited with ${code}${stderr ? `: ${stderr}` : ""}`));
    });
  });

  try {
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner.json"), "{");
    await ageDirectory(lockDir);
    await Promise.all([runWorker("first"), runWorker("second")]);
    const records = JSON.parse(await readFile(path.join(dataDir, "library.json"), "utf8"));
    assert.deepEqual(records.map((record) => record.id).sort(), ["first", "second"]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a dead owner can be recovered without waiting for the orphan-marker grace", async () => {
  const dataDir = await makeDataDir();
  const lockDir = path.join(dataDir, "library.json.lock");
  try {
    await mkdir(lockDir);
    await writeFile(path.join(lockDir, "owner.json"), JSON.stringify({ pid: 2_147_483_647 }));
    const result = await mutateLibrary(dataDir, (current) => [...current, { id: "recovered" }]);
    assert.deepEqual(result, [{ id: "recovered" }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
