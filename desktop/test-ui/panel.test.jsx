import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { emit } from "@tauri-apps/api/event";
import { App } from "../src/App.jsx";
import { ImportResult } from "../src/sections/StorageSection.jsx";
import { Markdown } from "../src/markdown.jsx";
import { lastCheckLabel } from "../src/validation.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const SECRET_VALUE = "sk-proj-THIS-IS-THE-SECRET-VALUE-ab12";
const RUNNING = {
  state: "running", port: 5173, url: "http://localhost:5173/", pid: 42, version: "1.0.0",
  managed: true, dataDir: "/u/data", cacheDir: "/u/cache", adopted: false,
};

function emptySecrets() {
  return Object.fromEntries([
    "GEMINI_API_KEY_PROD", "GEMINI_API_KEY_TEST", "GOOGLE_DRIVE_CLIENT_SECRET", "MINIMAX_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY",
  ].map((name) => [name, { present: false, hint: null }]));
}

/** A fake Rust side. Like the real one, it stores values but only ever returns presence and a hint. */
const UP_TO_DATE = {
  state: "upToDate", current: "1.0.0", checking: false, lastChecked: null, lastFailure: null,
  skippedVersion: null, autoCheck: true, updatedFrom: null,
};
const AVAILABLE = {
  ...UP_TO_DATE, state: "available", version: "1.0.1", date: "2026-11-27T10:00:00Z",
  notes: "## What's new\n- The version string is **visible**\n- <img src=x onerror=alert(1)>", skipped: false,
};

function fakeBackend({ hasKey = true, update = UP_TO_DATE, checkResult = AVAILABLE, eventBeforeReply = null } = {}) {
  const stored = new Map();
  if (hasKey) stored.set("OPENAI_API_KEY", "sk-old-key-ab12");
  const calls = [];
  let updateStatus = { ...update };
  const config = {
    config: {
      port: 5173, data_dir: null, cache_dir: null, allowed_hosts: [], launch_at_login: false, start_hidden: false,
      overrides: [], provider: "openai", google_drive: { client_id: "", redirect_uri: null, folder_id: "" }, open_wardrobe_in: "window",
    },
    data_dir: "/u/data", cache_dir: "/u/cache", default_data_dir: "/u/data", default_cache_dir: "/u/cache",
    default_port: 5173, config_file: "/u/config.json",
    drive_redirect_uri: "http://localhost:5173/api/google-drive/oauth/callback",
    default_drive_redirect_uri: "http://localhost:5173/api/google-drive/oauth/callback",
  };
  const status = () => {
    const all = emptySecrets();
    for (const [name, value] of stored) all[name] = { present: true, hint: `…${value.slice(-4)}` };
    return all;
  };
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case "app_info":
        return { version: "1.0.0", identifier: "app.wardrobe.desktop", sidecar_mode: "bundled", data_dir: "/u", cache_dir: "/u/cache", config_dir: "/u", log_dir: "/u/logs", server_log: "/u/logs/server.log", has_provider_key: stored.size > 0, secrets_persistent: true, platform: "windows" };
      case "get_config": return config;
      case "secret_status": return status();
      case "secret_set": stored.set(args.name, args.value.trim()); return null;
      case "secret_delete": stored.delete(args.name); return null;
      case "server_state": return RUNNING;
      case "server_health": return { ok: true, version: "1.0.0", uptime: 75, managed: true };
      case "server_logs": return [];
      case "autostart_get": return false;
      case "update_state": return updateStatus;
      case "update_check":
        // A check that joins a running one: the running check's result can
        // reach the panel as an event before this reply.
        if (eventBeforeReply) return emit("update-state", eventBeforeReply).then(() => ({ ...checkResult }));
        updateStatus = { ...checkResult }; return updateStatus;
      case "update_skip":
        updateStatus = {
          ...updateStatus,
          skippedVersion: args.version,
          skipped: updateStatus.state === "available" && args.version === updateStatus.version,
        };
        return updateStatus;
      case "update_install":
        updateStatus = { ...updateStatus, state: "ready", version: updateStatus.version };
        return updateStatus;
      case "open_help": return null;
      case "tailscale_status": return { state: "notInstalled", enabled: false, port: 5173, served: false, funnel: false, magicDns: false, https: false, online: false, url: null, message: null, health: [] };
      case "cache_status": return { cache_dir: "/u/cache", transformers: { path: "/u/cache/transformers", exists: false, bytes: 0 }, drapes: { path: "/u/cache/drapes", exists: false, bytes: 0 } };
      case "set_config": {
        const patch = args.patch;
        if (patch.port) {
          config.config.port = patch.port;
          config.default_drive_redirect_uri = `http://localhost:${patch.port}/api/google-drive/oauth/callback`;
        }
        if (patch.overrides) config.config.overrides = patch.overrides;
        if (patch.provider) config.config.provider = patch.provider;
        return config;
      }
      default: throw new Error(`unexpected command ${cmd}`);
    }
  }, { shouldMockEvents: true });
  return { calls, stored };
}

let container;
let root;

async function render(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(element); });
  await settle();
}

async function settle() {
  for (let i = 0; i < 5; i += 1) await act(async () => { await Promise.resolve(); });
}

function byText(selector, text) {
  return [...container.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
}

/** A rail button by its label (ignoring a badge next to it). */
function railItem(label) {
  return [...container.querySelectorAll("button.rail__item")].find((node) => node.firstChild?.textContent.trim() === label);
}

async function click(node) {
  expect(node, "element to click").toBeTruthy();
  await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

/** Sets a controlled input's value the way React expects. */
async function type(node, value) {
  const proto = node instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(node, value);
  await act(async () => { node.dispatchEvent(new Event("input", { bubbles: true })); });
  await settle();
}

async function submit(form) {
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await settle();
}

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  clearMocks();
});

describe("control panel", () => {
  it("shows a key as Set with its hint and never the value", async () => {
    const backend = fakeBackend();
    await render(<App />);
    await click(byText("button.rail__item", "AI provider"));

    const status = container.querySelector('[data-testid="status-OPENAI_API_KEY"]');
    expect(status.textContent).toBe("Set, ends with …ab12");
    expect(container.innerHTML).not.toContain("sk-old-key");

    await click(byText("button", "Replace"));
    const input = container.querySelector("#secret-OPENAI_API_KEY");
    expect(input.type).toBe("password");
    await type(input, SECRET_VALUE);
    await submit(input.closest("form"));

    expect(backend.calls).toContainEqual(["secret_set", { name: "OPENAI_API_KEY", value: SECRET_VALUE }]);
    expect(container.querySelector("#secret-OPENAI_API_KEY")).toBeNull();
    expect(container.innerHTML).not.toContain("THIS-IS-THE-SECRET");
    expect(container.querySelector('[data-testid="status-OPENAI_API_KEY"]').textContent).toBe("Set, ends with …ab12");
    for (const field of container.querySelectorAll("input, textarea")) expect(field.value).not.toContain("SECRET");
  });

  it("removes a key after a confirmation", async () => {
    const backend = fakeBackend();
    await render(<App />);
    await click(byText("button.rail__item", "AI provider"));
    await click(byText("button", "Remove"));
    await click(byText(".confirm button", "Remove"));
    expect(backend.calls).toContainEqual(["secret_delete", { name: "OPENAI_API_KEY" }]);
    expect(container.querySelector('[data-testid="status-OPENAI_API_KEY"]').textContent).toBe("Not set");
  });

  it("opens on the AI screen with an intro when no key exists", async () => {
    fakeBackend({ hasKey: false });
    await render(<App />);
    expect(container.querySelector('[data-testid="first-launch"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="status-OPENAI_API_KEY"]').textContent).toBe("Not set");
  });

  it("saves the selected provider before adding its key", async () => {
    const backend = fakeBackend({ hasKey: false });
    await render(<App />);
    const select = container.querySelector('select[aria-label="Provider"]');
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(select, "gemini");
    await act(async () => { select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(container.querySelector('[data-testid="status-GEMINI_API_KEY_TEST"]').textContent).toBe("Not set");
    expect(container.textContent).toContain("no billing account attached");

    await click(container.querySelector('[data-secret="GEMINI_API_KEY_TEST"] button'));
    const input = container.querySelector("#secret-GEMINI_API_KEY_TEST");
    await type(input, "AIza-test-key-0000");
    await submit(input.closest("form"));

    const order = backend.calls.map(([cmd]) => cmd).filter((cmd) => cmd === "set_config" || cmd === "secret_set");
    expect(order).toEqual(["set_config", "secret_set"]);
    expect(backend.calls).toContainEqual(["set_config", { patch: { provider: "gemini" } }]);
    expect(container.querySelector('[data-testid="status-GEMINI_API_KEY_TEST"]').textContent).toBe("Set, ends with …0000");
    expect(container.querySelector('[data-testid="first-launch"]')).toBeNull();
  });

  it("validates overrides before saving", async () => {
    const backend = fakeBackend();
    await render(<App />);
    await click(byText("button.rail__item", "AI provider"));
    const textarea = container.querySelector("#overrides");
    const save = byText("button", "Save overrides");

    await type(textarea, "OPENAI_API_KEY=sk-nope\nwardrobe_data_dir=x");
    const errors = container.querySelector('[data-testid="override-errors"]').textContent;
    expect(errors).toContain("Line 1: OPENAI_API_KEY is a secret, use the key fields above");
    expect(errors).toContain("Line 2: write KEY=value");
    expect(save.disabled).toBe(true);

    await type(textarea, "WARDROBE_DATA_DIR=/elsewhere");
    expect(container.querySelector('[data-testid="override-errors"]').textContent).toContain("set by the desktop app itself");

    await type(textarea, "OPENAI_IMAGE_MODEL=gpt-image-2\nOPENAI_IMAGE_ROUTE=responses");
    expect(container.querySelector('[data-testid="override-errors"]')).toBeNull();
    expect(save.disabled).toBe(false);
    await click(save);
    expect(backend.calls).toContainEqual(["set_config", { patch: { overrides: [
      { key: "OPENAI_IMAGE_MODEL", value: "gpt-image-2" },
      { key: "OPENAI_IMAGE_ROUTE", value: "responses" },
    ] } }]);
  });

  it("validates the port and shows the matching redirect URI", async () => {
    const backend = fakeBackend();
    await render(<App />);
    await click(byText("button.rail__item", "Storage"));
    const input = container.querySelector("#port");
    const form = input.closest("form");

    await type(input, "70000");
    expect(container.querySelector('[data-testid="port-error"]').textContent).toBe("Enter a port number between 1 and 65535.");
    expect(form.querySelector('button[type="submit"]').disabled).toBe(true);
    await submit(form);
    expect(backend.calls.some(([cmd]) => cmd === "set_config")).toBe(false);

    await type(input, "5174");
    expect(container.querySelector('[data-testid="port-error"]')).toBeNull();
    expect(form.textContent).toContain("http://localhost:5174/api/google-drive/oauth/callback");
    await submit(form);
    expect(backend.calls).toContainEqual(["set_config", { patch: { port: 5174 } }]);
  });

  it("follows server-state events", async () => {
    fakeBackend();
    await render(<App />);
    expect(container.querySelector(".rail__status").textContent).toBe("Running on port 5173");
    await act(async () => { await emit("server-state", { state: "starting", port: 5174 }); });
    await settle();
    expect(container.querySelector(".rail__status").textContent).toBe("Starting on port 5174…");
    await act(async () => { await emit("server-state", { state: "failed", port: 5174, reason: "Port 5174 is in use by another program.", lastLines: ["err: boom"] }); });
    await settle();
    expect(container.querySelector('[data-testid="server-state"]').textContent).toBe("Failed");
    expect(container.textContent).toContain("Port 5174 is in use by another program.");
  });

  it("renders the remote access section (details in remote.test.jsx)", async () => {
    fakeBackend();
    await render(<App />);
    await click(byText("button.rail__item", "Remote access"));
    expect(container.textContent).not.toContain("Coming in a later version.");
    expect(container.querySelector('[data-testid="tailscale-state"]').textContent).toBe("Tailscale is not installed on this computer.");
  });
});

describe("updates", () => {
  it("checks on demand and offers the new version with its notes", async () => {
    const backend = fakeBackend();
    await render(<App />);
    await click(byText("button.rail__item", "Updates"));
    expect(container.querySelector('[data-testid="current-version"]').textContent).toBe("v1.0.0");
    expect(container.textContent).toContain("Wardrobe is up to date.");
    expect(container.querySelector('[data-testid="last-check"]').textContent).toBe("Not checked yet");

    await click(byText("button", "Check for updates"));
    expect(backend.calls.map(([cmd]) => cmd)).toContain("update_check");
    expect(container.textContent).toContain("Wardrobe v1.0.1 is available");
    const notes = container.querySelector('[data-testid="release-notes"]');
    expect(notes.querySelector("strong").textContent).toBe("visible");
    expect(notes.querySelectorAll("li")).toHaveLength(2);
    // The release body is rendered as text, never as markup.
    expect(notes.querySelector("img")).toBeNull();
    expect(notes.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(container.querySelector('[aria-label="update available"]')).toBeTruthy();

    await click(byText("button", "Install and restart"));
    expect(backend.calls.map(([cmd]) => cmd)).toContain("update_install");
    expect(container.textContent).toContain("Installing v1.0.1. Wardrobe will restart in a moment.");
  });

  it("skips a version and can stop skipping", async () => {
    const backend = fakeBackend({ update: AVAILABLE });
    await render(<App />);
    expect(container.querySelector('[aria-label="update available"]')).toBeTruthy();
    await click(railItem("Updates"));
    await click(byText("button", "Skip this version"));
    expect(backend.calls).toContainEqual(["update_skip", { version: "1.0.1" }]);
    expect(container.textContent).toContain("You skipped v1.0.1.");
    expect(byText("button", "Install and restart")).toBeUndefined();
    expect(container.querySelector('[aria-label="update available"]')).toBeNull();

    await click(byText("button", "Stop skipping"));
    expect(backend.calls).toContainEqual(["update_skip", { version: null }]);
    expect(byText("button", "Install and restart")).toBeTruthy();
  });

  it("follows update-state events: progress, then a failure that keeps this version", async () => {
    fakeBackend({ update: AVAILABLE });
    await render(<App />);
    await click(railItem("Updates"));
    await act(async () => { await emit("update-state", { ...AVAILABLE, state: "downloading", received: 25, total: 100 }); });
    await settle();
    expect(container.textContent).toContain("Downloading v1.0.1… 25%");
    expect(byText("button", "Check for updates").disabled).toBe(true);
    await act(async () => { await emit("update-state", { ...AVAILABLE, state: "failed", version: "1.0.1", reason: "The download failed: connection reset" }); });
    await settle();
    expect(container.querySelector('[role="alert"]').textContent).toContain("The update to v1.0.1 failed. The download failed: connection reset");
    expect(container.textContent).toContain("This version keeps working.");
    expect(byText("button", "Check for updates").disabled).toBe(false);
  });

  it("opens on the Updates section from the URL fragment and on show-section", async () => {
    fakeBackend();
    window.location.hash = "#updates";
    try {
      await render(<App />);
      expect(container.querySelector("#updates-title")).toBeTruthy();
    } finally {
      window.location.hash = "";
    }
    await click(byText("button.rail__item", "Status"));
    expect(container.querySelector("#updates-title")).toBeNull();
    await act(async () => { await emit("show-section", "updates"); });
    await settle();
    expect(container.querySelector("#updates-title")).toBeTruthy();
  });

  it("keeps a running check's result when a joined check replies late", async () => {
    fakeBackend({ checkResult: { ...UP_TO_DATE, checking: true }, eventBeforeReply: AVAILABLE });
    await render(<App />);
    await click(railItem("Updates"));
    await click(byText("button", "Check for updates"));
    await settle();
    expect(container.textContent).toContain("Wardrobe v1.0.1 is available");
    expect(byText("button", "Check for updates").disabled).toBe(false);
  });

  it("words the last-check line", () => {
    const now = 1_000_000 * 1000;
    expect(lastCheckLabel({ lastChecked: 1_000_000 - 180, lastFailure: null }, now)).toBe("Checked 3 minutes ago");
    expect(lastCheckLabel({ lastChecked: 1_000_000 - 30, lastFailure: null }, now)).toBe("Checked just now");
    expect(lastCheckLabel({ lastChecked: 1_000_000 - 7200, lastFailure: { at: 1_000_000 - 60, reason: "offline" } }, now))
      .toBe("Last check failed 1 minute ago: offline");
    expect(lastCheckLabel({ lastChecked: 1_000_000 - 60, lastFailure: { at: 1_000_000 - 7200, reason: "offline" } }, now))
      .toBe("Checked 1 minute ago");
  });
});

describe("release notes markdown", () => {
  it("renders headings, lists, code and links as text", async () => {
    await render(<Markdown text={"# Title\n\nSome `code` and [the docs](https://example.com/x).\n\n1. one\n2. two\n\n```\nraw <b>\n```"} />);
    expect(container.querySelector("h4").textContent).toBe("Title");
    expect(container.querySelector("p code").textContent).toBe("code");
    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("the docs (https://example.com/x)");
    expect(container.querySelectorAll("ol li")).toHaveLength(2);
    expect(container.querySelector("pre").textContent).toBe("raw <b>");
    expect(container.querySelector("b")).toBeNull();
  });
});

describe("import result", () => {
  it("offers Replace for a populated target", async () => {
    let replaced = false;
    await render(<ImportResult outcome={{ status: "targetPopulated", to: "/u/data", message: "already" }} onReplace={() => { replaced = true; }} />);
    await click(byText("button", "Replace"));
    expect(replaced).toBe(true);
  });
  it("shows the summary and the backup path", async () => {
    await render(<ImportResult outcome={{ status: "imported", files: 12, bytes: 2048, warnings: ["one warning"], to: "/u/data", backup: "/u/data.before-import-x" }} />);
    expect(container.textContent).toContain("Imported 12 files (2.0 KB)");
    expect(container.textContent).toContain("/u/data.before-import-x");
    expect(container.textContent).toContain("one warning");
  });
  it("lists validation errors", async () => {
    await render(<ImportResult outcome={{ status: "failed", exitCode: 2, code: "archive_invalid", message: "Not a valid archive", errors: ["No library.json"] }} />);
    expect(container.textContent).toContain("Not a valid archive");
    expect(container.textContent).toContain("No library.json");
  });
});
