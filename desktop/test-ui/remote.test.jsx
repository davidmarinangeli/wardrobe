// The Remote access screen (Feature 07) against a fake Rust side. Every
// Tailscale call is a command; the panel never runs anything itself.
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { REMOTE_EXPLANATION, RemoteSection, tailscaleStateLabel } from "../src/sections/RemoteSection.jsx";
import { qrMatrix, qrPath } from "../src/qr.jsx";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const NAME = "wardrobe-mac.tail1234.ts.net";
const URL_ = `https://${NAME}/`;
const BASE = {
  state: "connected", enabled: false, cli: "C:\\Program Files\\Tailscale\\tailscale.exe", backendState: "Running",
  dnsName: NAME, tailnet: "example.github", online: true, magicDns: true, https: true, served: false, serveTarget: null,
  funnel: false, port: 5173, remoteHost: null, url: URL_, health: [], message: null,
  downloadUrl: "https://tailscale.com/download", adminUrl: "https://login.tailscale.com/admin/dns",
};
const ON = { ...BASE, enabled: true, served: true, serveTarget: "http://127.0.0.1:5173", remoteHost: NAME };

function backend({ status = BASE, enableResult = ON, enableError = null, health = { url: `${URL_}api/health`, ok: true, elapsedMs: 3400, attempts: 2, status: 200, version: "1.0.0", error: null } } = {}) {
  let current = { ...status };
  const calls = [];
  mockIPC((cmd, args) => {
    calls.push([cmd, args]);
    switch (cmd) {
      case "tailscale_status": return current;
      case "tailscale_enable":
        if (enableError) throw enableError;
        current = { ...enableResult };
        return current;
      case "tailscale_disable":
        current = { ...BASE };
        return current;
      case "tailscale_health": return health;
      case "open_help": return null;
      default: throw new Error(`unexpected command ${cmd}`);
    }
  });
  return { calls, commands: () => calls.map(([cmd]) => cmd) };
}

let container;
let root;

async function settle() {
  for (let i = 0; i < 6; i += 1) await act(async () => { await Promise.resolve(); });
}

async function render(element) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => { root.render(element); });
  await settle();
}

async function click(node) {
  expect(node, "element to click").toBeTruthy();
  await act(async () => { node.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await settle();
}

const byText = (selector, text) => [...container.querySelectorAll(selector)].find((node) => node.textContent.trim() === text);
const toggle = () => container.querySelector('input[type="checkbox"]');
const testId = (id) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => { document.body.innerHTML = ""; });
afterEach(async () => {
  await act(async () => { root?.unmount(); });
  clearMocks();
  vi.restoreAllMocks();
});

describe("remote access", () => {
  it("shows the state line, the explanation and the toggle", async () => {
    const fake = backend();
    const onConfigChanged = vi.fn();
    await render(<RemoteSection info={{ platform: "windows" }} onConfigChanged={onConfigChanged} />);
    expect(testId("tailscale-state").textContent).toBe(`Connected as ${NAME}`);
    expect(container.textContent).toContain(REMOTE_EXPLANATION);
    expect(toggle().checked).toBe(false);
    expect(toggle().disabled).toBe(false);
    expect(testId("remote-url")).toBeNull();
    expect(fake.commands()).toEqual(["tailscale_status"]);
  });

  it("enables remote access, then shows the URL, the QR code and the health result", async () => {
    const fake = backend();
    const onConfigChanged = vi.fn();
    await render(<RemoteSection info={{ platform: "windows" }} onConfigChanged={onConfigChanged} />);
    await click(toggle());
    expect(fake.commands()).toEqual(["tailscale_status", "tailscale_enable", "tailscale_health"]);
    expect(onConfigChanged).toHaveBeenCalled();
    expect(toggle().checked).toBe(true);
    expect(testId("remote-url").textContent).toBe(URL_);
    const qr = testId("qr-code");
    expect(qr.getAttribute("role")).toBe("img");
    expect(qr.querySelector("path").getAttribute("d").length).toBeGreaterThan(100);
    expect(testId("remote-health").textContent).toBe("Reachable through Tailscale (answered in 3.4 s).");
  });

  it("copies the URL", async () => {
    backend({ status: ON });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await render(<RemoteSection info={{}} />);
    await click(byText("button", "Copy"));
    expect(writeText).toHaveBeenCalledWith(URL_);
    expect(byText("button", "Copied")).toBeTruthy();
  });

  it("checks health on open when already on, and reports a failure", async () => {
    const fake = backend({ status: ON, health: { url: `${URL_}api/health`, ok: false, elapsedMs: 60000, attempts: 30, status: null, error: "Could not connect." } });
    await render(<RemoteSection info={{}} />);
    expect(fake.commands()).toEqual(["tailscale_status", "tailscale_health"]);
    expect(testId("remote-health").textContent).toBe("Not reachable yet. Could not connect.");
    await click(byText("button", "Check again"));
    expect(fake.commands().filter((cmd) => cmd === "tailscale_health")).toHaveLength(2);
  });

  it("disables remote access", async () => {
    const fake = backend({ status: ON });
    await render(<RemoteSection info={{}} />);
    await click(toggle());
    expect(fake.commands()).toContain("tailscale_disable");
    expect(toggle().checked).toBe(false);
    expect(testId("remote-url")).toBeNull();
  });

  it("explains why enabling failed and opens the troubleshooting with the DNS flags", async () => {
    const fake = backend({
      status: { ...BASE, magicDns: false, https: false },
      enableError: "MagicDNS is off for your tailnet. Turn on MagicDNS and HTTPS Certificates in the Tailscale admin console (DNS page), then try again.",
    });
    await render(<RemoteSection info={{}} />);
    await click(toggle());
    expect(container.querySelector('[role="alert"]').textContent).toContain("MagicDNS is off");
    expect(toggle().checked).toBe(false);
    expect(container.querySelector("details").open).toBe(true);
    expect(testId("magic-dns").textContent).toBe("Off");
    expect(testId("https-certs").textContent).toBe("Off");
    await click(byText("button", "Open the DNS page"));
    expect(fake.calls).toContainEqual(["open_help", { topic: "tailscale-dns" }]);
  });

  it("offers Download when Tailscale is missing, and the toggle stays off", async () => {
    const fake = backend({ status: { ...BASE, state: "notInstalled", dnsName: null, url: null, magicDns: false, https: false, online: false } });
    await render(<RemoteSection info={{}} />);
    expect(testId("tailscale-state").textContent).toBe("Tailscale is not installed on this computer.");
    expect(toggle().disabled).toBe(true);
    await click(byText("button", "Download Tailscale"));
    expect(fake.calls).toContainEqual(["open_help", { topic: "tailscale-download" }]);
  });

  it("warns when the serve rule is gone and offers to turn it on again", async () => {
    const fake = backend({ status: { ...ON, served: false, serveTarget: null } });
    await render(<RemoteSection info={{}} />);
    expect(container.textContent).toContain("Tailscale no longer serves Wardrobe at this address.");
    await click(byText("button", "Turn on again"));
    expect(fake.commands()).toContain("tailscale_enable");
    expect(container.textContent).not.toContain("no longer serves");
  });

  it("warns about a rule it would replace, and about Funnel", async () => {
    backend({ status: { ...BASE, serveTarget: "http://127.0.0.1:3000" } });
    await render(<RemoteSection info={{}} />);
    expect(container.textContent).toContain(`https://${NAME}/ already points at http://127.0.0.1:3000. Turning remote access on replaces it.`);
    await act(async () => { root.unmount(); });
    clearMocks();
    backend({ status: { ...ON, funnel: true } });
    await render(<RemoteSection info={{}} />);
    expect(container.textContent).toContain("reachable from the public internet");
  });

  it("words every Tailscale state", () => {
    expect(tailscaleStateLabel(null)).toBe("Checking Tailscale…");
    expect(tailscaleStateLabel({ state: "loggedOut" })).toBe("Tailscale is not logged in.");
    expect(tailscaleStateLabel({ state: "unavailable" })).toBe("Tailscale is installed but not running.");
    expect(tailscaleStateLabel({ state: "stopped" })).toBe("Tailscale is turned off.");
    expect(tailscaleStateLabel({ state: "connected", dnsName: NAME, online: false })).toBe(`Connected as ${NAME} (offline)`);
  });
});

describe("qr code", () => {
  it("encodes the URL with finder patterns and a quiet zone", () => {
    const matrix = qrMatrix(URL_);
    expect(matrix.length).toBeGreaterThanOrEqual(25);
    expect(matrix.every((row) => row.length === matrix.length)).toBe(true);
    // The top-left finder pattern: a 7x7 dark ring.
    expect(matrix[0].slice(0, 7).every(Boolean)).toBe(true);
    expect(matrix[6].slice(0, 7).every(Boolean)).toBe(true);
    expect(matrix[1][1]).toBe(false);
    expect(qrPath([[true, false], [false, true]], 4)).toBe("M4 4h1v1h-1zM5 5h1v1h-1z");
  });
});
