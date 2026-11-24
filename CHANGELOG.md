# Changelog

## 1.2.2

### Added

- Diagnosability for the "the terminal's session menu is missing while tmux sessions exist" failure: every `tmux.sessions` call (`detect`, `attachOrCreate`, `waitForSession`) is logged with its outcome and duration, and kept in a 50-entry ring that a new admin diagnostics section (Termix 26.11.3's diagnostics report, guarded for 26.11.2) exposes together with the service registration state (`provided`, `conflictWith`, `providedAt`, `lastError`). `detectTmuxViaHandle` now reports the swallowed stage and reason (version check vs list-sessions) instead of failing silently — the terminal swallows our errors, so this ring is the trace

### Fixed

- `detect` accepts a shell handle without `write`: only `exec` is needed to run commands, and refusing the terminal's handle there would blind the session menu on every host (attach/create still require `write`)

## 1.2.1

### Fixed

- The `tmux.sessions` service now speaks the plugin API 2 contract the terminal actually uses: `ssh-terminal` cannot hand out ssh2 objects across plugin processes, so it passes a shell handle — `{ termixShellKey, exec(command) -> {stdout, stderr, code}, write(data) }`. The service previously called the ssh2 callback API on that handle, so `detect` never resolved and opening a terminal never listed or proposed the host's attached sessions. Detection now runs through the handle's Promise-based `exec`, the generated-name record is keyed by the connection's `termixShellKey` (handle objects differ per call), and `list-sessions` also reports `session_created` / `session_last_activity` for the terminal's session picker
- Monitor routes classify the core's host-key refusals (`HOST_KEY_UNVERIFIED`, `HOST_KEY_CHANGED`) instead of lumping them into `TMUX_ERROR`: they now answer 409 with the core's user-facing message ("Open a terminal to the host once to check and trust it") and stay out of the plugin's error budget, like the other predictable host conditions

## 1.2.0

### Changed

- Migrated to plugin API 2 (`engine.api` `^2.0.0`, `engine.termix` `>=26.11.2`, built with `@termix-ssh/plugin-sdk` 2.11.0): an API 1 plugin no longer runs at all on a core that embeds API 2 (Termix 26.11.2+), so this release is required before upgrading the server to 26.11.2/26.11.3. Termix 26.11.3 ships no plugin-facing breaking change over 26.11.2 (SDK 2.11.0 only adds opt-in APIs, all marked 26.11.3), so the plugin is 26.11.3-ready as is
- The backend now runs in its own sandboxed plugin process: `ctx.services.providers("tmux.sessions")` is awaited (the only read the core turned into a Promise this plugin uses), and the manifest declares the `host.session.status` event topic under the new `sandbox` block
- Monitor error responses no longer rely on 5xx for predictable host conditions: tmux not installed answers 400 and no server running / unreachable host answer 409, so they stay out of the plugin's error budget (5 non-4xx errors per minute turn the plugin off). Response bodies and the frontend's handling of the `code` field are unchanged
- `express`, `ssh2`, `drizzle-orm` and `react` are declared as `peerDependencies` (the shell provides them; the plugin must not bundle its own copy)
- Backend tests run with `createMockCtx({ sandbox: true })`, applying the same rules as a real plugin process; a new frontend test walks `activate` with `checkFrameApp` to assert the app registers cleanly as a sandboxed frame

## 1.1.1

### Changed

- Rebuilt with `@termix-ssh/plugin-sdk` 1.1.6 (toolchain update; no behavior change, `engine.api` stays `^1.2` and Termix 26.10+/26.11.x stays supported)

## 1.1.0

### Changed

- The generated config is now pushed to `~/.tmux.conf` instead of `~/.termix/tmux.conf`, so every tmux server start loads it natively (tmux only reads `~/.tmux.conf` / `~/.config/tmux/tmux.conf` at startup)
- A pre-existing `~/.tmux.conf` the plugin did not generate is preserved once to `~/.tmux.conf.termix-backup` before the first overwrite; plugin-generated files and an existing backup are never re-copied
- A running tmux server is now always re-sourced (`source-file ~/.tmux.conf`) on apply, previously skipped when the user snippet was empty

## 1.0.0

### Added

- Session name pattern with {user}, {sshUser}, {host}, {date}, {uuid}… variables, applied to terminal-created and monitor-created sessions
- Per-host, per-folder, per-tag and fleet-wide tmux configuration management
- Server, user and folder host defaults through core's host-defaults hierarchy
- Config file pushed to ~/.termix/tmux.conf and applied to live sessions over SSH
- Named profiles and one-run profile overrides
- Optional auto-apply when a terminal session opens (events:core)
- Provides the terminal's tmux.sessions service: session creation follows the per-host configuration when tmux-monitor is disabled
- Graceful yield on the tmux.sessions provider conflict, surfaced in the tab and via /integration
- Full Tmux Monitor interface ported: session tree, pane preview, cross-pane search, split/kill/rename actions, per-user session tags and adaptive polling
- Docker deployment guide (DEPLOY-DOCKER.md), example compose file and prepare script; build post-process maps SDK imports to the names the shell resolves
- Preview of the generated file and commands before any apply, plus an application history
- Built-in default `configSnippet`: vim-style copy mode and pane navigation, fluid scroll in copy mode, minimal status bar, split/resize bindings, `default-terminal screen-256color` and `aggressive-resize` — appended to every generated `~/.termix/tmux.conf` unless a host overrides the snippet

### Changed

- The default reload binding targets `~/.termix/tmux.conf` (the file this plugin manages) instead of `~/.tmux.conf`
- The default snippet deliberately contains no `terminal-overrides 'smcup@:rmcup@:indn@'`: with `mouse on` (forced by the plugin), stripping the alternate-screen and scroll-region capabilities breaks mouse-wheel scrolling in full-screen applications (nano, vim, less)
