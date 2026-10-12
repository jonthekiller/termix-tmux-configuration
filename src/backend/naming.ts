/**
 * Session name patterns.
 *
 * A host's `sessionNamePattern` names the sessions this plugin creates, with
 * variables filled from the Termix user, the host and the clock. Pure string
 * work here; the SSH existence checks live in the service and the routes.
 *
 * tmux session names may not contain ":" or "." (they collide with target
 * syntax). Everything else printable is allowed, but this plugin keeps to a
 * conservative set — the same one the monitor's create-session route
 * validates against — so a generated name is safe as a tmux target
 * everywhere, including `=name` exact-match syntax.
 */

import { randomUUID } from "node:crypto";

export const SESSION_NAME_MAX = 64;
const SESSION_NAME_ALLOWED = /[A-Za-z0-9_@%+=-]/g;

export interface SessionNameVars {
  /** Login of the Termix user the session is created for. */
  user?: string;
  /** SSH login of the host the session runs on. */
  sshUser?: string;
  /** Host name (or IP when the host has no name). */
  host?: string;
  hostId?: number;
  now?: Date;
}

/** The variables a pattern may use, for UI hints. */
export const PATTERN_VARIABLES = [
  "{user}",
  "{sshUser}",
  "{host}",
  "{hostId}",
  "{date}",
  "{time}",
  "{datetime}",
  "{timestamp}",
  "{uuid}",
  "{random}",
] as const;

function two(n: number): string {
  return String(n).padStart(2, "0");
}

function fillVariable(name: string, vars: SessionNameVars): string {
  const now = vars.now ?? new Date();
  switch (name) {
    case "user":
      return vars.user ?? "unknown";
    case "sshUser":
      return vars.sshUser ?? "unknown";
    case "host":
      return vars.host ?? "unknown";
    case "hostId":
      return vars.hostId !== undefined ? String(vars.hostId) : "unknown";
    case "date":
      return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}`;
    case "time":
      return `${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    case "datetime":
      return `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
    case "timestamp":
      return now.getTime().toString(36);
    case "uuid":
      return randomUUID().replace(/-/g, "").slice(0, 8);
    case "random":
      return Math.random().toString(36).slice(2, 6);
    default:
      return "";
  }
}

/** Replaces every `{variable}` and drops unknown ones. */
export function buildSessionName(
  pattern: string,
  vars: SessionNameVars,
): string {
  const filled = pattern.replace(/\{([a-zA-Z]+)\}/g, (_match, name: string) =>
    fillVariable(name, vars),
  );
  return sanitizeSessionName(filled);
}

/** Replaces every character unsafe as a tmux target with "-", capped at 64. */
export function sanitizeSessionName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_@%+=-]/g, "-");
  return cleaned.slice(0, SESSION_NAME_MAX) || "termix-session";
}

/** True when the name is exactly the conservative set tmux targets accept. */
export function isValidSessionName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= SESSION_NAME_MAX &&
    (name.match(SESSION_NAME_ALLOWED) ?? []).join("") === name
  );
}

/**
 * Appends -2, -3, … until the name fits the limit. Callers combine this with
 * a `has-session` check to dodge a name that is already taken.
 */
export function withSuffix(name: string, attempt: number): string {
  if (attempt <= 1) return name;
  const suffix = `-${attempt}`;
  return name.slice(0, SESSION_NAME_MAX - suffix.length) + suffix;
}
