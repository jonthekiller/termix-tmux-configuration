/**
 * The tmux options this plugin manages.
 *
 * Every key here is declared in manifest.json under contributes.settings.host,
 * so core stores it, validates it, materializes folder/user/server defaults
 * into it and renders it in the Host Defaults editor. This catalog is the
 * backend mirror: what a stored value must look like and how it maps onto
 * tmux commands. Both sides must change together — a validator on activate
 * rejects a save that does not match.
 */

export type OnOff = "on" | "off";

export interface TmuxEffectiveConfig {
  historyLimit: number;
  mouse: OnOff;
  renumberWindows: OnOff;
  setClipboard: "external" | "internal" | "off";
  remainOnExit: OnOff;
  exitEmpty: OnOff;
  /**
   * Name pattern for sessions this plugin creates, with {user}, {sshUser},
   * {host}, {hostId}, {date}, {time}, {datetime}, {timestamp}, {uuid} and
   * {random} variables. Empty keeps the caller's suggested name.
   */
  sessionNamePattern: string;
  /** Free-form tmux option name to value, applied with `set-option -g -q`. */
  customOptions: Record<string, string>;
  /** Variables applied with `set-environment -g NAME value`. */
  environment: Record<string, string>;
  /** Raw tmux commands appended to the pushed config file. */
  configSnippet: string;
}

/**
 * Default extra tmux commands appended to every generated config file.
 * Vim-style copy mode and pane navigation, a minimal status bar and useful
 * bindings. The reload binding targets the file this plugin manages
 * (~/.tmux.conf), which tmux also reads at server start.
 *
 * Deliberately NO `terminal-overrides 'smcup@:rmcup@:indn@'`: stripping the
 * alternate-screen and scroll-region capabilities breaks mouse-wheel
 * scrolling in full-screen applications (nano, vim, less) while the plugin
 * forces `mouse on` — without smcup/rmcup tmux no longer routes the wheel to
 * the application and falls back to copy mode instead.
 */
export const DEFAULT_CONFIG_SNIPPET = `# -----------------------------------------------------------------------------
# Mode copie / scroll (vim)
# -----------------------------------------------------------------------------
setw -g mode-keys vi

# Scroll fluide dans le mode copie
bind -T copy-mode-vi WheelUpPane select-pane \\; send-keys -X -N 2 scroll-up
bind -T copy-mode-vi WheelDownPane select-pane \\; send-keys -X -N 2 scroll-down

# -----------------------------------------------------------------------------
# Status Bar Minimaliste
# -----------------------------------------------------------------------------
set -g status on
set -g status-justify centre
set -g status-left ""
set -g status-right "#[fg=green]#H#[default] | #[fg=cyan]%Y-%m-%d#[default] | #[fg=yellow]%H:%M#[default]"
set -g status-style "bg=black,fg=white"

# -----------------------------------------------------------------------------
# Keybindings utiles
# -----------------------------------------------------------------------------
# Reload de la config gérée par le plugin
bind r source-file ~/.tmux.conf \\; display-message "Config reloaded!"

# Split panes
bind | split-window -h
bind - split-window -v

# Navigation entre panes (vim-like)
bind h select-pane -L
bind j select-pane -D
bind k select-pane -U
bind l select-pane -R

# Resize panes
bind -r H resize-pane -L 5
bind -r J resize-pane -D 5
bind -r K resize-pane -U 5
bind -r L resize-pane -R 5

# -----------------------------------------------------------------------------
# Colors & UI
# -----------------------------------------------------------------------------
set -g default-terminal "screen-256color"
setw -g aggressive-resize on

# -----------------------------------------------------------------------------
# Plugins (TPM - Tmux Plugin Manager) - Optionnel
# -----------------------------------------------------------------------------
# set -g @plugin 'tmux-plugins/tpm'
# set -g @plugin 'tmux-plugins/tmux-sensible'
# set -g @plugin 'tmux-plugins/tmux-yank'
# run '~/.tmux/plugins/tpm/tpm'`;

export const DEFAULT_CONFIG: TmuxEffectiveConfig = {
  historyLimit: 50000,
  mouse: "on",
  renumberWindows: "off",
  setClipboard: "external",
  remainOnExit: "off",
  exitEmpty: "on",
  sessionNamePattern: "",
  customOptions: {},
  environment: {},
  configSnippet: DEFAULT_CONFIG_SNIPPET,
};

/** tmux option names: alphanumerics and dashes, or a user option `@name`. */
export const TMUX_OPTION_NAME = /^(@?[a-zA-Z0-9][a-zA-Z0-9_-]*)$/;

/** Environment variable names: POSIX-ish, no `=`, no leading digit. */
export const ENV_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/**
 * Host-setting keys, in the order they are edited. The values are exactly the
 * manifest field keys, so a settings row decodes straight into this shape.
 */
export const HOST_KEYS = [
  "historyLimit",
  "mouse",
  "renumberWindows",
  "setClipboard",
  "remainOnExit",
  "exitEmpty",
  "sessionNamePattern",
  "customOptions",
  "environment",
  "configSnippet",
] as const;

export type HostKey = (typeof HOST_KEYS)[number];

/**
 * Merges stored host settings (as returned by ctx.settings.getHost, with
 * core's materialized defaults already applied) over the catalog defaults.
 * Unknown or mistyped keys fall back to the default instead of breaking the
 * whole config.
 */
export function effectiveConfig(
  stored: Record<string, unknown> | null | undefined,
): TmuxEffectiveConfig {
  const s = stored ?? {};
  const onOff = (value: unknown, fallback: OnOff): OnOff =>
    value === "on" || value === "off" ? value : fallback;

  let historyLimit = DEFAULT_CONFIG.historyLimit;
  if (typeof s.historyLimit === "number" && Number.isFinite(s.historyLimit)) {
    historyLimit = Math.min(
      100_000_000,
      Math.max(1000, Math.round(s.historyLimit)),
    );
  }

  let customOptions: Record<string, string> = {};
  if (s.customOptions && typeof s.customOptions === "object") {
    for (const [key, value] of Object.entries(
      s.customOptions as Record<string, unknown>,
    )) {
      if (TMUX_OPTION_NAME.test(key) && value !== null && value !== undefined) {
        customOptions[key] = String(value);
      }
    }
  }

  let environment: Record<string, string> = {};
  if (s.environment && typeof s.environment === "object") {
    for (const [key, value] of Object.entries(
      s.environment as Record<string, unknown>,
    )) {
      if (ENV_NAME.test(key) && value !== null && value !== undefined) {
        environment[key] = String(value);
      }
    }
  }

  const configSnippet =
    typeof s.configSnippet === "string"
      ? s.configSnippet
      : DEFAULT_CONFIG.configSnippet;

  const sessionNamePattern =
    typeof s.sessionNamePattern === "string" ? s.sessionNamePattern : "";

  return {
    historyLimit,
    mouse: onOff(s.mouse, DEFAULT_CONFIG.mouse),
    renumberWindows: onOff(s.renumberWindows, DEFAULT_CONFIG.renumberWindows),
    setClipboard:
      s.setClipboard === "internal" || s.setClipboard === "off"
        ? s.setClipboard
        : DEFAULT_CONFIG.setClipboard,
    remainOnExit: onOff(s.remainOnExit, DEFAULT_CONFIG.remainOnExit),
    exitEmpty: onOff(s.exitEmpty, DEFAULT_CONFIG.exitEmpty),
    sessionNamePattern,
    customOptions,
    environment,
    configSnippet,
  };
}

/**
 * Validates the JSON fields of a host-settings save. Registered with
 * ctx.settings.onSettingsValidate so a malformed object is refused with a
 * per-field message instead of being silently dropped.
 */
export function validateJsonFields(
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const key of ["customOptions", "environment"] as const) {
    const value = values[key];
    if (value === undefined) continue;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors[key] = "Must be a JSON object of name to value.";
      continue;
    }
    const test = key === "customOptions" ? TMUX_OPTION_NAME : ENV_NAME;
    for (const [name, entry] of Object.entries(value)) {
      if (!test.test(name)) {
        errors[key] = `"${name}" is not a valid name.`;
        break;
      }
      if (typeof entry !== "string" && typeof entry !== "number") {
        errors[key] = `"${name}" must be a string or a number.`;
        break;
      }
    }
  }
  return errors;
}
