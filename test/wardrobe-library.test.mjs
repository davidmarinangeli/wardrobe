import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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

async function fileIdentity(file) {
  const info = await stat(file, { bigint: true });
  return `${info.dev}:${info.ino}`;
}

async function leftoverTemporaries(dataDir) {
  return (await readdir(dataDir)).filter((name) => name.endsWith(".tmp"));
}

test("a mutation that changes nothing leaves library.json untouched", async () => {
  const dataDir = await makeDataDir();
  const file = path.join(dataDir, "library.json");
  try {
    await mutateLibrary(dataDir, () => [{ id: "kept", image: "imported/kept.png" }]);
    const identity = await fileIdentity(file);
    const bytes = await readFile(file, "utf8");
    const result = await mutateLibrary(dataDir, (records) => records.map((record) => ({ ...record })));
    assert.deepEqual(result, [{ id: "kept", image: "imported/kept.png" }]);
    assert.equal(await fileIdentity(file), identity, "an unchanged catalog must not be replaced");
    assert.equal(await readFile(file, "utf8"), bytes);
    assert.deepEqual(await leftoverTemporaries(dataDir), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a missing library.json is still created by an empty mutation", async () => {
  const dataDir = await makeDataDir();
  try {
    const result = await mutateLibrary(dataDir, (records) => records);
    assert.deepEqual(result, []);
    assert.equal(await readFile(path.join(dataDir, "library.json"), "utf8"), "[]\n");
    assert.deepEqual(await leftoverTemporaries(dataDir), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("compact and CRLF files with the same content are not rewritten", async (t) => {
  const records = [{ id: "a", image: "imported/a.png", tags: ["x"] }];
  const variants = {
    compact: JSON.stringify(records),
    crlf: `${JSON.stringify(records, null, 2).replace(/\n/g, "\r\n")}\r\n`,
  };
  for (const [name, text] of Object.entries(variants)) {
    await t.test(name, async () => {
      const dataDir = await makeDataDir();
      const file = path.join(dataDir, "library.json");
      try {
        await writeFile(file, text);
        const identity = await fileIdentity(file);
        await mutateLibrary(dataDir, (current) => current);
        assert.equal(await fileIdentity(file), identity);
        assert.equal(await readFile(file, "utf8"), text, "the original formatting is kept");
      } finally {
        await rm(dataDir, { recursive: true, force: true });
      }
    });
  }
});

test("a mutation that changes the content is written", async () => {
  const dataDir = await makeDataDir();
  const file = path.join(dataDir, "library.json");
  try {
    await writeFile(file, JSON.stringify([{ id: "a" }]));
    await mutateLibrary(dataDir, (records) => records.map((record) => ({ ...record, name: "Renamed" })));
    assert.equal(await readFile(file, "utf8"), `${JSON.stringify([{ id: "a", name: "Renamed" }], null, 2)}\n`);
    // Legacy asset URLs differ from their portable form, so they are rewritten too.
    await writeFile(file, JSON.stringify([{ id: "a", image: "/api/import/library/a.png" }]));
    await mutateLibrary(dataDir, (records) => records);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [{ id: "a", image: "imported/a.png" }]);
    assert.deepEqual(await leftoverTemporaries(dataDir), []);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("an in-place edit by the mutation is still written", async () => {
  const dataDir = await makeDataDir();
  const file = path.join(dataDir, "library.json");
  try {
    await writeFile(file, JSON.stringify([{ id: "a" }]));
    await mutateLibrary(dataDir, (records) => { records[0].name = "Edited"; return records; });
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), [{ id: "a", name: "Edited" }]);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
