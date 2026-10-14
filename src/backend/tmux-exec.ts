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

export interface TmuxSessionSummary {
  name: string;
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

  const sessions: TmuxSessionSummary[] = [];
  try {
    const output = await execCommand(
      conn,
      tmuxCommand(
        `list-sessions -F "#{session_name}|#{session_windows}|#{session_attached}" 2>/dev/null`,
      ),
    );
    for (const line of output.split("\n").filter(Boolean)) {
      const [name, windows, attached] = line.split("|");
      sessions.push({
        name,
        windows: parseInt(windows, 10) || 0,
        attachedClients: parseInt(attached, 10) || 0,
      });
    }
  } catch {
    // No tmux server running yet: no sessions, nothing to apply live.
  }
  return { available: true, sessions };
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
