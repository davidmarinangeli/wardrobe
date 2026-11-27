# Feature 01 — Standalone server

## Scope and ownership

Make the Wardrobe server runnable without Vite: one command that serves the built frontend from `dist/` and mounts every API plugin, with a fixed plugin order shared with `vite.config.mjs`. This is the process the desktop shell will spawn in Feature 03 and the process `tailscale serve` will proxy in Feature 07.

This feature does not touch secrets handling, data locations or the React code. It does not change behaviour under `npm run dev` or `npm run preview`.

The CODER owns `scripts/server.mjs`, a shared plugin registry, the host allow-list middleware, the health endpoint, tests under `test/`, and the `npm run start` script.

## Observed state

- `vite.config.mjs` instantiates fifteen plugins in a fixed order (`googleDriveApi` first, then `react()`, then the API plugins). Every API plugin implements both `configureServer` and `configurePreviewServer`, each doing `server.middlewares.use(createArchiveRequestHandler(dataDir, handler))`. `responsiveImageApi` mounts at a path (`use("/_ipx", …)`).
- Every plugin reads `config.root` in `configResolved`. `responsiveImageApi` also reads `config.publicDir` and `config.build.outDir`. `googleDriveApi` reads `config.command`, `config.publicDir`, `config.build.outDir`, and hooks `server.httpServer.once("close", …)` to stop its sync worker.
- Plugins resolve settings as `options.env?.[name] || process.env[name] || fallback`. `vite.config.mjs` passes `loadEnv(mode, cwd, "")`, which includes `.env`. Outside Vite, `process.env` alone must be enough.
- `createArchiveRequestHandler` and `createArchiveAdmissionMiddleware` in `scripts/archive-coordinator.mjs` are plain `connect`-style middlewares.
- Vite's preview server enforces `allowedHosts: ["localhost"]`. The dev server allows `localhost` and `terminal.local`. Both bind `0.0.0.0`.
- `connect` and `sirv` are already in `node_modules` as Vite dependencies but are not declared in `package.json`.

## Design

### Shared plugin registry

Move the plugin list out of `vite.config.mjs` into `scripts/api-plugins.mjs`:

```js
export function apiPlugins({ env }) {
  return [googleDriveApi({ env }), responsiveImageApi(), wardrobeImportApi({ env }), /* … same order … */ browserStateApi({ env })];
}
```

`vite.config.mjs` becomes `plugins: [...apiPluginsBefore, react(), ...apiPluginsAfter]`. Keep `googleDriveApi` before `react()` and the rest after it, exactly as today. The simplest shape is two exported arrays or one function that takes a `{ react }` slot; pick one and record it in the notes.

### `scripts/server.mjs`

A plain `node:http` server with a `connect` app:

1. Parse flags: `--port` (default `5173`), `--host` (default `127.0.0.1`), `--root` (default: the repo root resolved from the script location), `--data-dir` (default `WARDROBE_DATA_DIR` or `data`), `--cache-dir` (reserved for Feature 02, accepted now), `--allowed-hosts` (comma list, merged with `WARDROBE_ALLOWED_HOSTS`), `--dist` (default `<root>/dist`). Flags win over environment variables.
2. Build a config shim `{ root, publicDir: <root>/public, build: { outDir: dist }, command: "serve", mode: "production" }` and call every plugin's `configResolved(shim)` in registry order, awaiting each.
3. Build the server shim `{ middlewares: app, httpServer }` and call every plugin's `configurePreviewServer(shim)` in order. `googleDriveApi` must receive a real `httpServer` so its close hook works.
4. Mount, in this order: host allow-list middleware, `createArchiveAdmissionMiddleware(dataDir)` (mirror how Vite mounts it today; check `googleDriveApi` because it mounts the admission middleware itself in `configureServer`), the plugin middlewares, then static files from `dist/` with `sirv` in SPA mode (`single: true`, `etag: true`, no `dev`), then a 404.
5. Add `GET /api/health` → `{ ok: true, version, dataDir, cacheDir, managed: false, pid, uptime }`. `version` comes from `package.json`. Feature 02 flips `managed`.
6. Start listening, print one line `wardrobe-server listening on http://<host>:<port>` to stdout, and write `READY` as its own line so a parent process can wait for it.
7. Shutdown: on `SIGINT`, `SIGTERM`, or when `stdin` closes (the reliable signal on Windows when the parent dies), close the HTTP server, let in-flight archive work finish through the existing coordinator, and exit `0`. A hard timeout of 10 s forces exit.

### Host allow-list

Replicates the DNS-rebinding protection Vite gives for free. Accept the request when the `Host` header (without port) is `localhost`, `127.0.0.1`, `[::1]`, or in the allow-list. The allow-list accepts exact names and `.suffix` entries (`.ts.net` means any subdomain). Reject with `403` and a JSON body naming the host. Only applies to `/api/` and `/_ipx/` routes and to `/` (the HTML); static assets are harmless but simpler to treat the same way, so apply it to everything.

### Dependencies

Add `connect` and `sirv` to `dependencies` with the versions already installed. No other new dependency.

### Package scripts

- `"start": "node --env-file-if-exists=.env scripts/server.mjs"` for a built checkout. Node 22.9+ supports `--env-file-if-exists`.
- `npm run check` stays `npm test && npm run build`.

## Implementation sequence

1. Extract `scripts/api-plugins.mjs`, rewire `vite.config.mjs`, run `npm run check` to prove dev and preview are untouched.
2. Write `scripts/server.mjs` with flag parsing, shims, health, static, shutdown.
3. Add the allow-list middleware as its own export (`scripts/host-allowlist.mjs`) so Feature 07 can extend it.
4. Audit each plugin's `configResolved` and `configurePreviewServer` for any Vite field the shim lacks. Fix the shim, not the plugin, unless the plugin reads something only Vite can give.
5. Add tests and the `start` script. Record the exact flag names, the ready line, and the health schema in the notes.

## Verification and acceptance

- Test: start `scripts/server.mjs` programmatically (export a `startServer(options)` function used by the CLI) on port `0`, with `--root` pointing at a temporary copy that contains a stub `dist/index.html` and an empty data directory. Assert `/api/health` returns `ok`, `/` returns the HTML, `/api/import/wardrobe` (or the cheapest read endpoint) returns a valid empty library, `/_ipx/` answers, and an unknown path returns `404`.
- Test: `Host: evil.example` is rejected with `403`; `Host: mac.tail1234.ts.net` is accepted when `--allowed-hosts .ts.net` is passed and rejected without it.
- Test: a `POST /api/setup/config` with a mismatched `Origin` is still rejected (`isSameOriginRequest` unchanged).
- Test: sending `SIGTERM` (POSIX) or closing stdin returns within 10 s with exit code `0`.
- Manual: `npm run build && npm run start` on this checkout serves the real wardrobe at `http://localhost:5173` with imports, outfits and Drive status all working. Document this run in the notes.
- `npm run check` passes.
