/**
 * Whether this plugin actually answers "tmux.sessions" — the terminal's
 * optional provider for session detection and attach. Single unnamed
 * provider, so tmux-monitor and this plugin cannot both hold it: whoever
 * activates second yields and `conflictWith` records the winner.
 */
export const tmuxServiceState: {
  provided: boolean;
  conflictWith: string | null;
} = { provided: false, conflictWith: null };
