# Changelog

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
