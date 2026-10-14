<div align="center">

<img src="https://raw.githubusercontent.com/Termix-SSH/Termix/main/public/icon.svg" width="120" height="120" alt="Termix Logo" />

<h1>Tmux Configuration</h1>

<p>A Termix plugin: manage the tmux configuration of your hosts — per host, per folder, per tag or for every machine.</p>

</div>

<br />

## ⚠️ Replaces Tmux Monitor

> [!IMPORTANT]
> This plugin provides the terminal's `tmux.sessions` service, exactly like the bundled **Tmux Monitor** plugin. **Both cannot hold the service at once**: whoever activates second yields and fails to start.
>
> Before using this plugin: **Admin → Plugins → disable Tmux Monitor**, then restart Termix. Re-enable it to hand the service back — both directions are safe. See [Replacing Tmux Monitor](#replacing-tmux-monitors-session-handling) for the full details.

## Install

1. Download `tmux-configuration-<version>.tmxplug` from the [releases](../../releases) page.
2. Drop the file into your Termix plugins directory (`/app/data/plugins/` when running in Docker), or upload it from **Admin → Plugins**.
3. **Disable Tmux Monitor** (Admin → Plugins) and restart Termix — the terminal's tmux sessions then follow this plugin's configuration.

The artifact is unpacked fresh at each boot into `plugins/.unpacked/<id>/`; no signature is required unless `TERMIX_REQUIRE_SIGNED_PLUGINS=true` (see [DEPLOY-DOCKER.md](DEPLOY-DOCKER.md)).

## Overview

Termix ships a tmux integration whose session options are fixed in code (`mouse`, `history-limit 50000`, the `tmux -u` invocation and the PATH it searches in `plugins/tmux-monitor/src/backend/tmux-commands.ts`). This plugin adds the missing management layer, without forking Termix:

- **Per host, per group, global.** Every option is a host-scoped setting declared `defaultable`, so core's host-defaults hierarchy applies for free: a host override beats its folder's default, which beats the user's default, which beats the server-wide default. Hosts are also targeted by **folder** and by **tag** for one-click bulk applies.
- **Push + live apply.** A generated `tmux.conf` is pushed to `~/.tmux.conf` through a quoted heredoc (data, never shell), so every tmux server start picks it up natively. A pre-existing config the plugin did not generate is preserved once to `~/.tmux.conf.termix-backup`. The options are also applied to every live session over a separate exec channel — the same pattern tmux-monitor uses, so the interactive shell is never polluted.
- **Optional auto-apply.** When a terminal session opens on an enabled host, the plugin waits a moment and applies the effective configuration (`events:core`).
- **Profiles, preview and history.** Save the effective configuration of one host as a named profile and apply it to any selection as a one-run override; preview the exact file and commands before touching anything; every apply lands in a per-user history.

## Managed options

| Setting                              | tmux option                    | Default  |
| ------------------------------------ | ------------------------------ | -------- |
| History limit                        | `history-limit`                | 50000    |
| Mouse                                | `mouse`                        | on       |
| Renumber windows                     | `renumber-windows`             | off      |
| Clipboard                            | `set-clipboard`                | external |
| Keep pane after command exits        | `remain-on-exit`               | off      |
| Close server when last session exits | `exit-empty`                   | on       |
| Custom options                       | `set-option -g <name> <value>` | —        |
| Environment variables                | `set-environment -g`           | —        |
| Extra tmux commands                  | appended to the pushed file    | —        |

Custom option names and environment variable names are validated on every save path (host editor, defaults level, profiles).

## Surfaces

- A **Tmux Configuration** tab: hosts × options matrix with the effective values, bulk apply (selection, tag, folder, all), profiles and history.
- A **Tmux Monitor** tab: the cross-host tmux session browser, with a host action from any monitored host.
- A **host editor section** (SSH group) with the enable switch and a reset-to-default per key.
- Host defaults (server / user / folder) are edited through core's own Host Defaults editor — the plugin only declares the fields.

## Development

```bash
npm install
npx termix-plugin validate   # manifest check
npx tsc -p tsconfig.json     # typecheck
npx vitest run               # tests
npx termix-plugin build      # dist/backend.js + dist/frontend.js
```

Requires **Termix 26.10+** (plugin API ^1.2) with the plugins loader enabled. For a Termix 2.9 server, build with `node scripts/postbuild.mjs --legacy` after `npm run build` (see DEPLOY-DOCKER.md).

Running Termix in Docker? See [DEPLOY-DOCKER.md](DEPLOY-DOCKER.md): mount the built plugin under `/app/data/plugins/` (or drop a `.tmxplug` there), grant the capabilities, enable it — and how to switch tmux-monitor off for good. `deploy/prepare.sh` builds and lays the folder out; `deploy/docker-compose.example.yml` is a ready-to-adapt compose file.

## Replacing tmux-monitor's session handling

The terminal talks to tmux through the `tmux.sessions` service, provided by the bundled tmux-monitor plugin. That service is what writes the hardcoded `mouse`/`history-limit` into every created session (`attachOrCreate`). This plugin **provides the same service (v1)**, so when it is active and tmux-monitor is disabled, session creation itself follows the per-host configuration — options are set on the session before the attach, including when attaching to an existing session.

- The service is a single unnamed provider: **tmux-monitor and this plugin cannot hold it at the same time.** Whoever activates second yields (the registry refuses the duplicate, and only that plugin fails to start). This plugin catches the conflict, logs it and keeps working — configuration push, live apply and auto-apply never depend on winning it. The tab shows a banner with the current state (`GET /integration`).
- The provider is gated by the `tmux-configuration.sessions` permission (granted to the admin and user roles by default). A role without it sees the terminal fall back to a plain shell when tmux is detected, so grant it wherever `tmux-monitor.use` was granted.
- The **monitor UI is ported**: the same session tree (windows, panes, per-pane CPU/memory/GPU), cross-pane output search, split / kill / rename / new-window actions, per-user session tags, adaptive polling and the resizable tree. It lives in its own **Tmux Monitor** tab, opens from a host row, and is opt-in per host through the host editor's enable switch.
- One caveat when switching: tmux-monitor stores its per-user session tags in its own namespaced table, and this plugin creates a fresh one. Existing tags are not migrated automatically — re-tagging a session takes seconds and this plugin's tags table starts clean.

## Limits

- A host without a running tmux server still gets the config file; the live application is skipped until a server exists.

<br />

## License

Distributed under the Apache License Version 2.0.
