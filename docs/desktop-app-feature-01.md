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

## Implementation notes

Implemented on `feat/desktop-app` on 2026-11-26 (Windows 11, Node 24.14.1, npm 11). Nothing was committed by the coder.

### Files

| File | What it is |
| --- | --- |
| `scripts/api-plugins.mjs` | Shared plugin registry. `apiPlugins({ env, react } = {})` returns the 15 plugins in the historical order: `googleDriveApi`, then the optional `react` slot, then `responsiveImageApi`, `wardrobeImportApi`, `outfitsApi`, `inspoApi`, `wishlistApi`, `suggestionsApi`, `mirrorApi`, `wardrobeSetupApi`, `preferencesApi`, `colorProfileApi`, `variantApi`, `cheatSheetsApi`, `browserStateApi`. Shape chosen: **one function with a `{ react }` slot**. |
| `vite.config.mjs` | Now `plugins: apiPlugins({ env, react: react() })`. Everything else (dev/preview hosts, `fs.deny`, warmup) is unchanged. |
| `scripts/server.mjs` | Standalone server and CLI. Exports `startServer(options)`, `resolveServerOptions(options, env)`, `main(argv)`, `DEFAULT_PORT` (5173), `DEFAULT_HOST` (`127.0.0.1`), `READY_LINE` (`"READY"`), `SHUTDOWN_TIMEOUT_MS` (10000). |
| `scripts/host-allowlist.mjs` | `createHostAllowlist({ allowedHosts })` (connect middleware), `isHostAllowed(hostHeader, entries)`, `parseAllowedHosts(...sources)`, `hostnameFromHostHeader(header)`, `ALLOWED_HOSTS_ENV` (`"WARDROBE_ALLOWED_HOSTS"`). Feature 07 extends this module. |
| `scripts/fs-durability.mjs` | `fsyncDirectory(directory)`: a directory fsync that is a no-op on Windows (see deviation 2). |
| `scripts/archive-coordinator.mjs` | New export `drainArchiveWriters()`. `withArchiveWriteLease` now records each new (non-inherited) lease in an in-process set. Directory syncs go through `fsyncDirectory`. |
| `scripts/archive-restore.mjs`, `scripts/google-drive-sync.mjs`, `scripts/apply-prepared-outfits.mjs` | Directory syncs go through `fsyncDirectory`. No other change. |
| `test/standalone-server.test.mjs` | Feature tests (12 tests, 1 skipped on Windows). |
| `package.json` | `connect ^3.7.0` and `sirv ^3.0.2` in `dependencies`; `"start": "node --env-file-if-exists=.env scripts/server.mjs"`. `check` is unchanged. |
| `AGENTS.md` | One configuration-table row for `WARDROBE_ALLOWED_HOSTS`. |

### CLI

```text
node scripts/server.mjs [--port 5173] [--host 127.0.0.1] [--root <dir>]
  [--data-dir <dir>] [--cache-dir <dir>] [--dist <dir>]
  [--allowed-hosts a.example,.ts.net] [--watch-stdin auto|on|off] [-h|--help]
npm run start -- <same flags>
```

- `--port`: default `5173`. `0` picks a free port, and the ready line prints the real one. An invalid value fails with exit code `1`.
- `--host`: default `127.0.0.1`.
- `--root`: defaults to the repo root derived from the script location. When the module has no `import.meta.url` (the esbuild CJS bundle of Feature 03) it falls back to `process.cwd()`, so the bundle must always pass `--root`.
- `--data-dir`: default `WARDROBE_DATA_DIR`, else `<root>/data`. Relative values resolve against `root`.
- `--cache-dir`: default `WARDROBE_CACHE_DIR`, else `<root>/.cache`. For now it is only reported by health and passed to plugins as `WARDROBE_CACHE_DIR`; Feature 02 gives it consumers. The directory is not created.
- `--dist`: default `<root>/dist`. Relative values resolve against `root`.
- `--allowed-hosts`: comma list, may be repeated, merged with `WARDROBE_ALLOWED_HOSTS`. For every setting, flags win over environment variables.
- `--watch-stdin`: `auto` (default) watches stdin only when it is a pipe or a socket (Rust `Stdio::piped()`, Node `child_process` pipes, a shell pipe). A TTY, a file, or `NUL` / `/dev/null` is not watched, so `npm run start` in a terminal or with stdin redirected from `/dev/null` keeps running. `on` forces watching and `off` disables it. Feature 03 should spawn with a piped stdin (or pass `--watch-stdin on`) and close it to stop the server.
- Unknown flags or positionals print usage on stderr and exit with code `2`. Feature 02 adds the `import-data` subcommand and must turn `allowPositionals` on.
- On success, stdout gets exactly two lines before anything else the server writes there: `wardrobe-server listening on http://<host>:<port>`, then `READY`. Diagnostics go to stderr.
- A start failure prints `wardrobe-server failed to start: <reason>` on stderr and exits with code `1`. A busy port gives `Port <n> is already in use on <host>` (error code `EADDRINUSE` from `startServer`). A missing `<dist>/index.html` gives ``Built frontend not found at … Run `npm run build` first or pass --dist.``
- Shutdown triggers: `SIGINT`, `SIGTERM`, `SIGHUP` (also raised on Windows when the console window closes), `SIGBREAK` (Windows), and the end, close or error of stdin when it is watched. The server prints `wardrobe-server shutting down (<reason>)` to stderr, stops the Drive sync worker (googleDriveApi wraps the preview server's `close()`), closes the HTTP server (idle keep-alive sockets close at once, in-flight requests finish), awaits `drainArchiveWriters()`, and exits `0`. If that takes more than 10 s it exits `1` after printing `wardrobe-server forced exit after 10 s`.

### `startServer(options)`

Options: `port`, `host`, `root`, `dataDir`, `cacheDir`, `dist`, `allowedHosts` (string or array), `env` (base settings, default `process.env`), `log` (stderr line writer), `plugins` (override, for tests only). It resolves after `listen` with a handle `{ root, dataDir, cacheDir, dist, host, port, allowedHosts, url, version, env, app, httpServer, plugins, close() }`.

- `env` is **one shared object**, `{ ...baseEnv, WARDROBE_DATA_DIR: <absolute dataDir>, WARDROBE_CACHE_DIR: <absolute cacheDir> }`, passed to every plugin. It plays the role of Vite's `loadEnv` result. Plugins read `options.env[name]` before `process.env[name]`, so Feature 02's `.env` reload must mutate `handle.env` in place: it is a snapshot of `process.env`, not a live view.
- Startup order:
  1. Build the config shim `{ root, publicDir: <root>/public, build: { outDir: <dist> }, command: "serve", mode: "production", isProduction: true, base: "/", env: {} }`.
  2. Skip plugins with `apply: "build"`, or with an `apply` function that returns false.
  3. Await every `configResolved(shim)` **sequentially, in registry order**.
  4. Call every `configurePreviewServer(previewShim)` in order, where `previewShim = { config, middlewares: app, httpServer, resolvedUrls: null, close(), printUrls(), bindCLIShortcuts() }`. Functions those hooks return run afterwards, like Vite's post hooks; none exist today.
- Middleware order on the `connect` app:
  1. Host allow-list.
  2. `GET|HEAD /api/health`.
  3. Plugin middlewares. googleDriveApi's private-file guard, archive admission and handler come first because it is first in the registry.
  4. `sirv(dist, { single: true, etag: true, dev: false, ignores: ["^/api(/|$)", "^/_ipx(/|$)"] })`.
  5. 404: `{"error":{"code":"not_found","message":"Not found"}}` JSON under `/api/`, `Not found` as text elsewhere.
  6. Error handler: 500 JSON, logged through `log`.
- `close()` is idempotent and returns the same promise every time.

### Health

`GET /api/health` (also `HEAD`; other methods get `405`) with `Cache-Control: no-store`. It is mounted before the archive admission middleware, so it never waits on archive maintenance.

```json
{ "ok": true, "version": "1.0.0", "dataDir": "<absolute>", "cacheDir": "<absolute>", "managed": false, "pid": 1234, "uptime": 12 }
```

`uptime` is whole seconds since `startServer` began. `version` comes from the first of these that exists:

1. A bundle-time global `WARDROBE_VERSION` (Feature 03's esbuild `define`).
2. The `package.json` at the script's repo root.
3. `<root>/package.json`.
4. `"0.0.0"`.

Feature 02 flips `managed`.

### Host allow-list

The allow-list applies to every route. It compares the `Host` header with the port stripped, case-insensitively, ignoring a trailing dot. It accepts:

- `localhost` and any `*.localhost` name.
- Any IPv4 literal or bracketed IPv6 literal (`127.0.0.1`, `[::1]`, a LAN address).
- Exact allow-list entries.
- Subdomains of `.suffix` entries: `.ts.net` accepts `mac.tail1234.ts.net` but not `ts.net`.

A missing or malformed `Host` is rejected. A rejection is a `403` with `{"error":{"code":"host_not_allowed","message":"Host \"evil.example\" is not allowed. Add it with --allowed-hosts or WARDROBE_ALLOWED_HOSTS.","host":"evil.example"}}`.

`isSameOriginRequest` and the Drive `sameOrigin` check are unchanged. The server does not rewrite `Host`.

### Deviations from the plan, with reasons

1. **`connect` and `sirv` were not in `node_modules`.** Vite 6 bundles both into its own dist, so the "versions already installed" did not exist. I installed `connect@3.7.0` and `sirv@3.0.2`, the versions Vite 6.4.3 bundles (its devDependencies pin `^3.7.0` and `^3.0.2`). This adds 18 transitive packages to `package-lock.json` (`debug`, `finalhandler`, `parseurl`, `utils-merge`, `@polka/url`, `mrmime`, `totalist`, …). A hand-written router and static server would have avoided them, but would have reimplemented mount-path stripping (`/_ipx`), ETags, MIME types and path-traversal protection.
2. **Windows directory fsync (`scripts/fs-durability.mjs`).** On Windows, every archive writer lease failed with `EPERM: operation not permitted, fsync`, because Windows cannot fsync a directory handle. Neither `npm run dev` nor the standalone server could start on Windows, and 142 of 438 tests failed at `HEAD` (`18ff173`), most of them for this reason. All five directory-sync sites now call `fsyncDirectory`. It ignores `EPERM`, `EISDIR`, `EINVAL` and `EBADF` **only on `win32`**, where NTFS journals the metadata itself, and keeps the strict behaviour on every other platform. This change is outside the stated scope, but without it Feature 01's acceptance cannot pass on the Windows target.
3. **The server does not mount the admission middleware itself.** `googleDriveApi.configurePreviewServer` already mounts the private-file guard and `createArchiveAdmissionMiddleware(dataDir)`, exactly as under Vite. Mounting it again would admit every request twice, so the server mirrors Vite and mounts nothing extra.
4. **The host allow-list also accepts IP literals and `*.localhost`**, beyond `localhost`, `127.0.0.1` and `[::1]`. This matches Vite's own `allowedHosts` check: a DNS-rebinding attack needs a DNS name. The server binds `127.0.0.1` by default, so LAN addresses only matter if someone passes `--host 0.0.0.0`.
5. **`configResolved` runs sequentially**, as the plan says, whereas Vite runs the hooks concurrently. The archive coordinator already tolerates both. Sequential is deterministic and lets the Drive plugin finish startup recovery before other writers start.
6. **Shutdown drain.** The coordinator had no API to wait for in-flight work, so I added `drainArchiveWriters()`, an in-process set of the promises `withArchiveWriteLease` returns. Inherited leases are not tracked separately because their parent lease is. The forced exit after 10 s uses exit code `1`, not `0`, so a parent process can tell a forced exit from a clean one.
7. **stdin is watched automatically only when it is a pipe** (`--watch-stdin auto|on|off`). Watching it unconditionally would stop the server at once whenever stdin is `/dev/null` or `NUL`, as in background runs and services.
8. **A missing `dist/index.html` is a startup error** rather than a server that answers 404 for the UI, so the sidecar fails with a reason the user can act on.
9. **No counselor was consulted.** The workflow asked for a counselor subagent on real doubts, but this session had no Agent tool. A counselor would have reviewed decisions 1, 2 and 7; they are recorded here so a reviewer can revisit them.

### Verification run

- `node --test test/standalone-server.test.mjs`: 11 pass, 1 skipped. The `SIGTERM` test is skipped on Windows; the stdin-close test covers shutdown there. The suite covers:
  - Plugin registry: the order and the react slot, including the real `vite.config.mjs`, evaluated from an empty temporary working directory so the real `.env` is never read.
  - Options: precedence of flags over environment variables over defaults.
  - Host allow-list: unit cases; `403` for `evil.example` on every route type; `.ts.net` accepted only with `--allowed-hosts .ts.net`; `WARDROBE_ALLOWED_HOSTS`.
  - Routes: the health schema, `/` and the SPA fallback, a static asset with an ETag, `/api/import/wardrobe` returning `[]`, `/api/google-drive/status`, `/api/setup/providers`, `/_ipx/w_8/pixel.png` resizing a PNG to 8 px, and `404` for unknown `/api/` paths and missing files.
  - Same-origin: cross-origin and origin-less `POST /api/setup/config` are rejected with `403`, and no `.env` is written.
  - Startup and shutdown: missing dist and `EADDRINUSE` failures, `drainArchiveWriters`, `fsyncDirectory`, the CLI ready lines, and exit `0` within 10 s after stdin closes.
  - CLI usage errors.
- `npm run build` passes.
- `npm test` does **not** pass on this Windows machine, before or after this feature:

  | Run | Tests | Pass | Fail | Skipped |
  | --- | --- | --- | --- | --- |
  | Baseline at `HEAD`, exported with `git archive` | 438 | 296 | 142 | 0 |
  | After this feature, without `google-drive-feature04.test.mjs` | 412 | 358 | 53 | 1 |
  | `google-drive-feature04.test.mjs` alone, `--test-timeout=60000` | 36 | 20 | 15 | 0 |

  **No test that passed at baseline fails now**, and 71 baseline failures now pass. The reviewer ran the whole suite again with `--test-timeout=60000`: 450 tests, 380 pass, 69 fail, 1 skipped (baseline: 438 / 296 / 142). A test-by-test comparison found no regressions. The remaining failures are existing Windows problems in the tests or in the Drive archive code:
  - Hard-coded `/private/tmp` temp paths (macOS only).
  - An `import()` of a bare `C:\…` path (`ERR_UNSUPPORTED_ESM_URL_SCHEME`).
  - Drive sync ending in `sync_state_invalid`.
  - Drive restore ending in `remote_unavailable`.
  - A cross-process lease assertion.

  Without a per-test timeout, `google-drive-feature04.test.mjs` now **hangs** on Windows (in "keeps restore evidence pinned past the preview TTL…"); before this feature it failed fast on the fsync error. So `npm run check` cannot pass on Windows. It is expected to pass on macOS, which is still to be checked (see pending).
- `npm run dev` (`--port 5181`) and `npm run preview` (`--port 5182`), each with a temporary `WARDROBE_DATA_DIR`: `/`, `/api/import/wardrobe`, `/api/google-drive/status` and `/api/setup/providers` all answered `200`.
- Manual run: `npm run build`, then `npm run start -- --data-dir <temp> --cache-dir <temp>`. I used a temporary data directory because this checkout has no real `data/` and the run must not create one. No `.env` exists, so Node printed `.env not found. Continuing without it.` The server printed `wardrobe-server listening on http://127.0.0.1:5173` and `READY`. Through `http://localhost:5173`, these all answered `200` with the right content types:
  - `/` (888 B of HTML), the hashed JS bundle, `/sw.js`, `/manifest.webmanifest`.
  - `/api/health`, `/api/import/wardrobe` (`[]`), `/api/outfits`, `/api/google-drive/status` (`state: "unconfigured"`), `/api/import/config`, `/api/setup/providers`, `/api/preferences`, `/api/browser-state`.
  - `/_ipx/w_64/icon.svg`.

  I did not do a browser walkthrough (see pending).

### Pending manual verification

- macOS: `npm run check` passes, and the `SIGTERM` test runs and passes.
- A browser walkthrough of `npm run build && npm run start` on a checkout with a real wardrobe (`data/`, plus `.env` with an AI key): the gallery renders, an import runs end to end, outfits load, and Settings › Archive shows the Drive status. Not done here: this checkout has no real data, and the rules forbid touching a real `data/` or `.env`.
- The Google Drive OAuth callback through the standalone server on `localhost:5173`, which needs real `GOOGLE_DRIVE_*` values.
- Graceful shutdown with `SIGINT` from an interactive terminal (Ctrl+C) on macOS and Windows.

### Notes for later features

- Feature 02: `startServer` returns `env`; reload `.env` into that object. `main()` rejects positionals today; turn them on for `import-data`. `--cache-dir` and `WARDROBE_CACHE_DIR` are already parsed and reported.
- Feature 03: spawn with `--root`, `--dist`, `--data-dir`, `--cache-dir`, `--host 127.0.0.1` and a piped stdin (or `--watch-stdin on`), then wait for the `READY` line. Define `WARDROBE_VERSION` in esbuild. Exit code `1` together with a `wardrobe-server failed to start:` line means startup failed (port in use, missing dist).
- Windows target risk: the Drive archive restore and sync paths still fail several tests on Windows (see the verification run). Directory fsync is fixed. Restore and sync on Windows need their own investigation before a Windows release. A likely lead (found in review, not fixed here): `syncFile` in `scripts/archive-restore.mjs` fsyncs a handle opened with `"r"`, and on Windows `FileHandle.sync()` on a read-only handle fails with `EPERM` (FlushFileBuffers needs write access).
- Windows target risk, found in review: `npm run dev` on Windows sometimes fails at startup with `ArchiveMaintenanceError: Archive coordination state is invalid`, thrown from `acquireGate` in `scripts/archive-coordinator.mjs`. It failed 1 of 8 starts with a fresh data directory, and stray `gate.lock.<uuid>.tmp` files were left behind. Vite runs the plugins' `configResolved` hooks concurrently, so several writers in one process race for the gate file. This bug was already in the code: at `HEAD`, dev never started on Windows because of the fsync error. The standalone server runs those hooks one after another and did not hit it, but concurrent writers at runtime use the same gate. Feature 03 should look into it before a Windows release.
- Feature 07: add the tailnet name with `--allowed-hosts` or `WARDROBE_ALLOWED_HOSTS`, either as `.ts.net` or as the exact `*.ts.net` name.
