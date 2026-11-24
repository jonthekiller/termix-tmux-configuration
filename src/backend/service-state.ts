/**
 * Whether this plugin actually answers "tmux.sessions" — the terminal's
 * optional provider for session detection and attach. Single unnamed
 * provider, so tmux-monitor and this plugin cannot both hold it: whoever
 * activates second yields and `conflictWith` records the winner.
 *
 * The state also carries what an admin report needs when the terminal's
 * session menu is missing: when the service registered, the last
 * registration error, and the recent service calls (detect /
 * attachOrCreate / waitForSession) with their outcome. The ring answers
 * the diagnostics section and nothing else — never log secrets here.
 */
export interface TmuxServiceCallRecord {
  /** ISO timestamp of the call. */
  at: string;
  call: "detect" | "attachOrCreate" | "waitForSession";
  /** Wall time of the call, in milliseconds. */
  ms: number;
  ok: boolean;
  /** One line, no host addresses, no session content. */
  detail: string;
}

const MAX_CALL_RECORDS = 50;

export const tmuxServiceState: {
  provided: boolean;
  conflictWith: string | null;
  /** ISO timestamp of the moment provide() succeeded, null before. */
  providedAt: string | null;
  /** Last registration or service-level error message, one line. */
  lastError: string | null;
  /** True while the keepAwake reason holds the provider process open. */
  keepAwake: boolean;
  calls: TmuxServiceCallRecord[];
} = {
  provided: false,
  conflictWith: null,
  providedAt: null,
  lastError: null,
  keepAwake: false,
  calls: [],
};

/** Records one service call in the diagnostics ring (oldest entries drop). */
export function recordTmuxServiceCall(
  record: Omit<TmuxServiceCallRecord, "at">,
): void {
  tmuxServiceState.calls.push({ ...record, at: new Date().toISOString() });
  if (tmuxServiceState.calls.length > MAX_CALL_RECORDS) {
    tmuxServiceState.calls.splice(
      0,
      tmuxServiceState.calls.length - MAX_CALL_RECORDS,
    );
  }
}
