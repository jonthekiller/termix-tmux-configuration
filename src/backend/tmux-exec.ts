/**
 * Running tmux over SSH.
 *
 * The exec-channel pattern is the one tmux-monitor uses: every command runs
 * on a separate `conn.exec` channel so the interactive shell is never
 * polluted, and the PATH is widened first because tmux often sits in a
 * homebrew/opt directory outside the non-login default PATH.
 */

import type { Client } from "ssh2";
import { CONFIG_FILE_PATH } from "./config-builder.js";

const TMUX_PATH_DIRS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/bin",
  "/usr/pkg/bin",
];

export function withTmuxPath(command: string): string {
  const script = `PATH=${TMUX_PATH_DIRS.join(":")}:"$PATH"; export PATH; ${command}`;
  return `/bin/sh -c ${shellEscape(script)}`;
}

export function tmuxCommand(args: string): string {
  return withTmuxPath(`tmux -u ${args}`);
}

export function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Runs a command on the remote host, returning trimmed stdout. */
export function execCommand(conn: Client, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    conn.exec(command, (err, stream) => {
      if (err) {
        reject(err);
        return;
      }
      let stdout = "";
      let stderr = "";
      stream.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      stream.stderr.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });
      stream.on("error", (err: Error) => {
        reject(err);
      });
      stream.on("close", (code: number) => {
        if (code !== 0 && stdout === "") {
          reject(
            new Error(stderr.trim() || `Command exited with code ${code}`),
          );
        } else {
          resolve(stdout.trim());
        }
      });
    });
  });
}

/**
 * The handle the ssh-terminal plugin hands the tmux.sessions service under
 * plugin API 2: plain functions, since an ssh2 client cannot cross to
 * another plugin's process. `termixShellKey` is stable for one connection,
 * so it is the key services may record learned state under.
 */
export interface TmuxShellHandle {
  termixShellKey: string;
  exec: (command: string) => Promise<{
    stdout: string;
    stderr: string;
    code: number | null;
  }>;
  write: (data: string) => void;
}

/**
 * Runs one command through a shell handle, with execCommand's semantics:
 * a non-zero exit with no stdout rejects. This is the only way to run
 * commands when the caller is the terminal — the handle's exec takes no
 * callback and answers a Promise.
 */
export async function execViaHandle(
  handle: TmuxShellHandle,
  command: string,
): Promise<string> {
  const { stdout, stderr, code } = await handle.exec(command);
  if (code !== 0 && stdout.trim() === "") {
    throw new Error(stderr.trim() || `Command exited with code ${code}`);
  }
  return stdout.trim();
}

export interface TmuxSessionSummary {
  name: string;
  created?: number;
  lastActivity?: number;
  windows: number;
  attachedClients: number;
}

export type TmuxAvailability =
  { available: true; sessions: TmuxSessionSummary[] } | { available: false };

/** `-V` answers only when a tmux binary exists; sessions may still be empty. */
export async function detectTmux(
  conn: Client,
): Promise<{ available: boolean; sessions: TmuxSessionSummary[] }> {
  try {
    await execCommand(conn, tmuxCommand("-V"));
  } catch {
    return { available: false, sessions: [] };
  }

  const sessions = await listTmuxSessions((command) =>
    execCommand(conn, command),
  );
  return { available: true, sessions };
}

/** Parses one `list-sessions` output line into a session summary. */
function parseSessionLine(line: string): TmuxSessionSummary | null {
  const [name, created, lastActivity, windows, attached] = line.split("|");
  if (!name) return null;
  return {
    name,
    created: created ? parseInt(created, 10) * 1000 : undefined,
    lastActivity: lastActivity ? parseInt(lastActivity, 10) * 1000 : undefined,
    windows: parseInt(windows, 10) || 0,
    attachedClients: parseInt(attached, 10) || 0,
  };
}

/**
 * Runs `list-sessions` through a runner and parses the summaries, with the
 * creation and activity timestamps the terminal's session picker reads.
 */
async function listTmuxSessions(
  run: (command: string) => Promise<string>,
): Promise<TmuxSessionSummary[]> {
  const output = await run(
    tmuxCommand(
      `list-sessions -F "#{session_name}|#{session_created}|#{session_last_activity}|#{session_windows}|#{session_attached}" 2>/dev/null`,
    ),
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map(parseSessionLine)
    .filter((s): s is TmuxSessionSummary => s !== null);
}

/**
 * Same detection as detectTmux, through the shell handle the terminal's
 * tmux.sessions consumer passes under plugin API 2.
 */
export async function detectTmuxViaHandle(
  handle: TmuxShellHandle,
): Promise<{ available: boolean; sessions: TmuxSessionSummary[] }> {
  try {
    await execViaHandle(handle, tmuxCommand("-V"));
  } catch {
    return { available: false, sessions: [] };
  }
  try {
    const sessions = await listTmuxSessions((command) =>
      execViaHandle(handle, command),
    );
    return { available: true, sessions };
  } catch {
    // No tmux server running yet: no sessions, nothing to apply live.
    return { available: true, sessions: [] };
  }
}

/**
 * Waits for a named session to exist, polling on a separate exec channel.
 * Returns the confirmed name, or null on timeout.
 */
export async function waitForTmuxSession(
  conn: Client,
  sessionName: string,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await execCommand(
        conn,
        tmuxCommand(`has-session -t ${shellEscape(sessionName)} 2>/dev/null`),
      );
      return sessionName;
    } catch {
      // Session not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * Waits for a named session through a shell handle (the terminal's
 * tmux.sessions consumer passes handles, not ssh2 clients).
 */
export async function waitForTmuxSessionViaHandle(
  handle: TmuxShellHandle,
  sessionName: string,
  timeoutMs = 5000,
  intervalMs = 100,
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await execViaHandle(
        handle,
        tmuxCommand(`has-session -t ${shellEscape(sessionName)} 2>/dev/null`),
      );
      return sessionName;
    } catch {
      // Session not ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

/**
 * Applies one configuration: pushes the generated file, sources it when a
 * server is running (a running server never re-reads ~/.tmux.conf on its
 * own), then sets every live session's options. Returns the number of
 * sessions touched.
 */
export async function applyOnHost(
  conn: Client,
  config: import("./option-catalog.js").TmuxEffectiveConfig,
  fileContent: string,
  fileCommand: string,
  globalArgs: string,
  perSession: (sessionName: string) => string,
): Promise<{ sessionsTouched: number }> {
  await execCommand(conn, fileCommand);

  const detection = await detectTmux(conn);
  if (!detection.available || detection.sessions.length === 0) {
    // The file is in place; the next tmux server start reads it directly
    // (auto-apply on terminal session open covers the rest).
    return { sessionsTouched: 0 };
  }

  // A running server does not re-read ~/.tmux.conf on its own, so replay
  // the file over it. The file is idempotent by construction, and sourcing
  // is what carries the snippet (keybindings, status bar…) to the server.
  await execCommand(
    conn,
    tmuxCommand(`source-file ${shellEscape(CONFIG_FILE_PATH)}`),
  );

  await execCommand(conn, tmuxCommand(globalArgs));

  for (const session of detection.sessions) {
    await execCommand(conn, tmuxCommand(perSession(session.name)));
  }
  return { sessionsTouched: detection.sessions.length };
}
