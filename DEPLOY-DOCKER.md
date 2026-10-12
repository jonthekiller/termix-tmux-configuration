# Deploying into Docker

How to run this plugin inside a Dockerized Termix (image `ghcr.io/lukegus/termix`). Validated against `26.10.0` and `2.9.2`.

## How Termix loads plugins

The loader scans two roots at startup (`src/backend/plugins/paths.ts`):

| Root     | Path in the container                 | Notes                                                         |
| -------- | ------------------------------------- | ------------------------------------------------------------- |
| Bundled  | `/app/dist/plugins/` (image built-in) | part of the image; a user plugin with the same id is rejected |
| **User** | **`/app/data/plugins/`**              | your volume; this is where this plugin goes                   |

Two install shapes land there:

- a **plugin folder** — `<id>/manifest.json` + `<id>/dist/…`; loaded as-is. Refused only when `TERMIX_REQUIRE_SIGNED_PLUGINS=true`.
- a **`.tmxplug` artifact** — `name-1.0.0.tmxplug`, unpacked fresh at each boot into `plugins/.unpacked/<id>/`. A `.sig` next to it is verified against the keys pinned in the shell (`TRUSTED_PLUGIN_KEYS`, empty in the OSS build — so ship the unsigned artifact or sign with a key the shell trusts).

**Keep the plugin under `/app/data/plugins/`**: the backend bundle keeps `express` and `drizzle-orm` as external imports, resolved by walking up from the plugin directory to `/app/node_modules`. A plugin mounted anywhere else cannot resolve them.

After adding or changing files, **restart the container** — there is no directory watcher. Then enable the plugin in **Admin → Plugins**; a user plugin starts disabled, and each capability in its manifest (`db:own`, `hosts:read`, `ssh:connect`, …) must be granted once from the same page.

## Step by step

```bash
# 1. Build (the postbuild step renames the SDK imports to the names the
#    shell's import map resolves — see "Build note" below)
npm ci
npm run build

# 2. Lay out a deployment folder
mkdir -p deploy/plugins
rsync -a --delete \
  --include='manifest.json' --include='dist/***' --include='locales/***' \
  --include='migrations/***' --include='README.md' --include='LICENSE' \
  --exclude='*' ./ deploy/plugins/tmux-configuration/

# 3. Run Termix with the folder mounted (see deploy/docker-compose.example.yml)
docker compose -f deploy/docker-compose.example.yml up -d

# 4. In the web UI: create the admin, open Admin -> Plugins,
#    grant the capabilities, enable "Tmux Configuration".
```

Verify from outside:

```bash
# served frontend bundle — its SDK imports must read "@termix/plugin-sdk/…"
curl -s http://localhost:8080/plugin-assets/tmux-configuration/frontend.js \
  | grep -o 'from "@termix[^"]*"' | sort | uniq -c

# plugin API (auth required; 401 without a session, not 404)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:8080/plugin-api/tmux-configuration/hosts
```

Container logs should show, in order: `Loaded plugin tmux-configuration`, `Applied N migration(s)`, `Mounted /plugin-api/tmux-configuration`, `Activated plugin tmux-configuration`.

## Switching off tmux-monitor

This plugin provides the terminal's `tmux.sessions` service, like tmux-monitor does; both cannot hold it at once (the logs name the conflict, and the tab shows a banner). For the full takeover:

1. Admin → Plugins → disable **Tmux Monitor**.
2. `docker restart termix` (activation order is decided at boot).

On the next boot the logs show `Providing tmux.sessions: session creation follows the plugin's per-host configuration`, and no `tmux-monitor` mount. Re-enable tmux-monitor and restart to hand the service back — both directions are safe, only the plugin activating second fails to start, and this plugin yields cleanly instead.

## Build note (why scripts/postbuild.mjs exists)

The SDK specifiers a shell resolves changed with the calendar release: **26.10+ maps `@termix-ssh/plugin-sdk/frontend|ui`** (the npm name, also shipped in its `node_modules` for the backend), while **2.9.x mapped `@termix/plugin-sdk/frontend|ui`**. A bundle whose bare specifiers the shell does not map fails in the browser with `Failed to resolve module specifier` and in Node with `ERR_MODULE_NOT_FOUND`.

`npm run build` appends `scripts/postbuild.mjs`, which targets **26.10+ by default** (no rewrite needed; it fails the build if a stale `@termix/plugin-sdk/*` specifier is present). Building for a 2.9 server: `node scripts/postbuild.mjs --legacy` after the build renames the specifiers to the old names.

## Alternative: install from a .tmxplug artifact

```bash
npx termix-plugin pack            # writes tmux-configuration-<version>.tmxplug
mkdir -p deploy/plugins
cp tmux-configuration-*.tmxplug deploy/plugins/
docker compose -f deploy/docker-compose.example.yml restart termix
```

No `.sig` needed unless `TERMIX_REQUIRE_SIGNED_PLUGINS=true` is set (then a signature from a key pinned in the shell is mandatory, which for self-built plugins means building Termix itself with your key in `TRUSTED_PLUGIN_KEYS`).

## Uninstall

Admin → Plugins → the plugin's _Delete data_ action drops its tables, settings and grants. Remove the folder or `.tmxplug` from the volume and restart.
