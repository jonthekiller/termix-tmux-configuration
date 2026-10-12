# Tmux Configuration

Manage the tmux configuration of your hosts: per host, per folder, per tag or
for every machine.

- **Options**: history limit, mouse, renumber-windows, set-clipboard,
  remain-on-exit, exit-empty, custom `set-option -g` entries, global
  environment variables and an extra tmux commands snippet.
- **Hierarchy**: a host override beats its folder default, which beats the
  user's default, which beats the server-wide default (edited in core's Host
  Defaults editor).
- **Session name pattern**: `termix-{user}@{host}`, `{date}`, `{uuid}`…
  applies to terminal-created and monitor-created sessions.
- **Apply**: one host, a tag, a folder or all hosts, with a per-host report
  and an application history. Preview the generated file and commands first.
- **Tmux Monitor**: the session tree (windows, panes, per-pane CPU/memory/GPU),
  cross-pane output search, split/kill/rename actions and per-user tags.

## Replacing Tmux Monitor

This plugin provides the terminal's `tmux.sessions` service. Disable
**Tmux Monitor** and restart Termix to have session creation follow this
plugin's configuration; re-enable it to hand the service back.

## Environment variables

This plugin reads none.
